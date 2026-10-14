// Builds the probe scene: a VRCWorld, a floor, and two bare video players
// (AVPro, Unity), each driven by its own unsynced ModemProbe. Nothing is meant
// to be looked at; results are in the logs. Regenerates
// Assets/Scenes/ModemProbe.unity from scratch every run.
//
// The probe URL is baked in at build time (Udon can't construct URLs):
// VRMODEM_URL env var, default below. VRMODEM_MATRIX (whitespace-separated
// URLs) switches both probes to matrix mode: load each URL, log ready/failed.
// VRMODEM_INTERVALS (comma-separated seconds; 0 = every Udon frame, -k = k per
// frame) and VRMODEM_SEEKS (per interval) override the virtual seek schedule.
// VRMODEM_DOWN ("url|w|h|block|levels|seed;...") builds the downlink scene
// instead: one Unity player and a DownProbe that decodes each test video.
// VRMODEM_DOWN_PLAYER=avpro uses an AVPro player drawing into a screen material.
//
// Menu: vrmodem > Build Probe Scene
// Batch: Unity -batchmode -quit -projectPath <proj> -executeMethod ProbeSceneBuilder.Build

using UdonSharp;
using UdonSharp.Compiler;
using UdonSharpEditor;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRC.SDK3.Video.Components;
using VRC.SDK3.Video.Components.AVPro;
using VRC.SDK3.Video.Components.Base;
using VRC.SDKBase;

public static class ProbeSceneBuilder
{
    const string ScenePath = "Assets/Scenes/ModemProbe.unity";
    const string ScriptPath = "Assets/vrmodem/ModemProbe.cs";
    const string ProgramPath = "Assets/vrmodem/ModemProbe.asset";
    const string TexturePath = "Assets/vrmodem/ProbeVideo.renderTexture";
    const string DownScriptPath = "Assets/vrmodem/DownProbe.cs";
    const string DownProgramPath = "Assets/vrmodem/DownProbe.asset";
    // Project-only assets, outside the repository's symlinked folder.
    const string GeneratedDir = "Assets/Generated";
    const string WorldPrefab = "Packages/com.vrchat.worlds/Samples/UdonExampleScene/Prefabs/VRCWorld.prefab";
    const string DefaultUrl = "http://127.0.0.1:8787/v/{session}/probe.mp4?fps=60&seconds=69904&lead=30&pace=1";

    [MenuItem("vrmodem/Build Probe Scene")]
    public static void Build()
    {
        try
        {
            BuildScene();
        }
        catch (System.Exception e)
        {
            Debug.LogException(e);
            // -quit would otherwise report success.
            if (Application.isBatchMode) EditorApplication.Exit(1);
            throw;
        }
    }

    static void BuildScene()
    {
        EnsureProgram(ScriptPath, ProgramPath);
        EnsureProgram(DownScriptPath, DownProgramPath);
        UdonSharpCompilerV1.CompileSync(new UdonSharpCompileOptions());
        var url = System.Environment.GetEnvironmentVariable("VRMODEM_URL");
        if (string.IsNullOrEmpty(url)) url = DefaultUrl;
        var matrix = (System.Environment.GetEnvironmentVariable("VRMODEM_MATRIX") ?? "")
            .Split(new[] { ' ', '\t', '\n' }, System.StringSplitOptions.RemoveEmptyEntries);

        var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);

        var world = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(WorldPrefab));
        PrefabUtility.UnpackPrefabInstance(world, PrefabUnpackMode.Completely, InteractionMode.AutomatedAction);
        GameObject.CreatePrimitive(PrimitiveType.Plane).name = "Floor";

        // VRMODEM_LANES=N builds N AVPro players (Probe AVPro0..) as parallel
        // uplink lanes, with URL loads staggered for the rate limit.
        var down = System.Environment.GetEnvironmentVariable("VRMODEM_DOWN");
        int lanes;
        if (!string.IsNullOrEmpty(down)) AddDownProbe(down);
        else if (int.TryParse(System.Environment.GetEnvironmentVariable("VRMODEM_LANES"), out lanes) && lanes > 0)
        {
            for (int i = 0; i < lanes; i++)
            {
                var lane = new GameObject("Probe AVPro" + i);
                AddProbe(lane, lane.AddComponent<VRCAVProVideoPlayer>(), PlayerUrl(url, "avpro" + i), 6f * i, PlayerUrls(matrix, "avpro" + i));
            }
        }
        else
        {
            var avpro = new GameObject("Probe AVPro");
            AddProbe(avpro, avpro.AddComponent<VRCAVProVideoPlayer>(), PlayerUrl(url, "avpro"), 0f, PlayerUrls(matrix, "avpro"));

            // Unity player renders into a RenderTexture: no screen needed, and it
            // is the readback source for downlink experiments later.
            var unity = new GameObject("Probe Unity");
            var unityPlayer = unity.AddComponent<VRCUnityVideoPlayer>();
            var so = new SerializedObject(unityPlayer);
            so.FindProperty("renderMode").intValue = 0; // RenderTexture
            so.FindProperty("targetTexture").objectReferenceValue = EnsureRenderTexture();
            so.ApplyModifiedPropertiesWithoutUndo();
            AddProbe(unity, unityPlayer, PlayerUrl(url, "unity"), matrix.Length > 0 ? 6f : 8f, PlayerUrls(matrix, "unity"));
        }

        System.IO.Directory.CreateDirectory("Assets/Scenes");
        EditorSceneManager.SaveScene(scene, ScenePath);
        Debug.Log("[ProbeSceneBuilder] saved " + ScenePath + " url=" + url + " matrix=" + matrix.Length);
    }

    // Substitute at build time; each player gets its own baked session URL.
    static string PlayerUrl(string url, string session)
    {
        if (url.Contains("{session}")) return url.Replace("{session}", session);
        var uri = new System.UriBuilder(url);
        var parts = uri.Path.Split('/');
        if (parts.Length >= 4 && (parts[1] == "v" || parts[1] == "s"))
        {
            parts[2] = session;
            uri.Path = string.Join("/", parts);
        }
        return uri.Uri.AbsoluteUri;
    }

    static VRCUrl[] PlayerUrls(string[] urls, string session)
    {
        var result = new VRCUrl[urls.Length];
        for (int i = 0; i < urls.Length; i++) result[i] = new VRCUrl(PlayerUrl(urls[i], session));
        return result;
    }

    static void AddProbe(GameObject go, BaseVRCVideoPlayer player, string url, float startDelay, VRCUrl[] matrix)
    {
        var probe = UdonSharpUndo.AddComponent<ModemProbe>(go);
        probe.player = player;
        probe.url = new VRCUrl(url);
        probe.startDelay = startDelay;
        // Probes alternate loads, so each waits two load slots between URLs.
        probe.matrixUrls = matrix;
        var uri = new System.Uri(url);
        if (uri.AbsolutePath.StartsWith("/v/"))
        {
            int fps = 60, seconds = 3600;
            foreach (var param in uri.Query.TrimStart('?').Split('&'))
            {
                if (param.StartsWith("fps=")) fps = int.Parse(param.Substring(4));
                if (param.StartsWith("seconds=")) seconds = int.Parse(param.Substring(8));
            }
            probe.seekFps = fps;
            probe.seekFrames = (int)System.Math.Min(int.MaxValue, (long)fps * seconds);
            var intervals = System.Environment.GetEnvironmentVariable("VRMODEM_INTERVALS");
            if (!string.IsNullOrEmpty(intervals))
                probe.seekIntervals = System.Array.ConvertAll(intervals.Split(','),
                    v => float.Parse(v, System.Globalization.CultureInfo.InvariantCulture));
            int seeks;
            if (int.TryParse(System.Environment.GetEnvironmentVariable("VRMODEM_SEEKS"), out seeks) && seeks > 0)
                probe.seeksPerInterval = seeks;
        }
        // AVPro's runtime Loop setter does not persist its serialized value.
        var playerSettings = new SerializedObject(player);
        playerSettings.FindProperty("loop").boolValue = false;
        playerSettings.ApplyModifiedPropertiesWithoutUndo();
        UdonSharpEditorUtility.CopyProxyToUdon(probe);
    }

    static void EnsureProgram(string scriptPath, string programPath)
    {
        if (AssetDatabase.LoadAssetAtPath<UdonSharpProgramAsset>(programPath) != null) return;
        var asset = ScriptableObject.CreateInstance<UdonSharpProgramAsset>();
        asset.sourceCsScript = AssetDatabase.LoadAssetAtPath<MonoScript>(scriptPath);
        AssetDatabase.CreateAsset(asset, programPath);
        AssetDatabase.SaveAssets();
        Debug.Log("[ProbeSceneBuilder] created " + programPath);
    }

    // A generated RenderTexture asset, recreated when its size or format changed.
    static RenderTexture GeneratedTexture(string name, int w, int h, RenderTextureFormat format, bool linear)
    {
        System.IO.Directory.CreateDirectory(GeneratedDir);
        var path = GeneratedDir + "/" + name + ".renderTexture";
        var rt = AssetDatabase.LoadAssetAtPath<RenderTexture>(path);
        if (rt != null && rt.width == w && rt.height == h && rt.format == format && rt.sRGB == !linear) return rt;
        if (rt != null) AssetDatabase.DeleteAsset(path);
        rt = new RenderTexture(w, h, 0, format, linear ? RenderTextureReadWrite.Linear : RenderTextureReadWrite.sRGB);
        rt.useMipMap = false;
        rt.filterMode = FilterMode.Point;
        AssetDatabase.CreateAsset(rt, path);
        return rt;
    }

    static void AddDownProbe(string spec)
    {
        var entries = spec.Split(new[] { ';' }, System.StringSplitOptions.RemoveEmptyEntries);
        int n = entries.Length;
        var urls = new VRCUrl[n];
        var blocks = new int[n];
        var levels = new int[n];
        var seeds = new int[n];
        var decoded = new RenderTexture[n];
        int w = 0, h = 0;
        for (int i = 0; i < n; i++)
        {
            var f = entries[i].Split('|');
            urls[i] = new VRCUrl(f[0]);
            w = int.Parse(f[1]);
            h = int.Parse(f[2]);
            blocks[i] = int.Parse(f[3]);
            levels[i] = int.Parse(f[4]);
            seeds[i] = int.Parse(f[5]);
            // Downlink.shader's target: cols x (rows + 1), float, linear (DOWNLINK.md).
            decoded[i] = GeneratedTexture("DownDecoded" + i, w / blocks[i], (h - 16) / blocks[i] + 1, RenderTextureFormat.ARGBFloat, true);
        }
        var video = GeneratedTexture("DownVideo", w, h, RenderTextureFormat.ARGB32, false);

        var matPath = GeneratedDir + "/Downlink.mat";
        var mat = AssetDatabase.LoadAssetAtPath<Material>(matPath);
        if (mat == null)
        {
            mat = new Material(Shader.Find("vrmodem/Downlink"));
            AssetDatabase.CreateAsset(mat, matPath);
        }

        bool avpro = System.Environment.GetEnvironmentVariable("VRMODEM_DOWN_PLAYER") == "avpro";
        var go = new GameObject("Probe Down");
        BaseVRCVideoPlayer player;
        Material screen = null;
        if (avpro)
        {
            player = go.AddComponent<VRCAVProVideoPlayer>();
            // A quad nobody looks at: AVPro puts its texture into the quad's material.
            var quad = GameObject.CreatePrimitive(PrimitiveType.Quad);
            quad.name = "Down Screen";
            quad.transform.position = new Vector3(0, -10, 0);
            var screenPath = GeneratedDir + "/DownScreen.mat";
            screen = AssetDatabase.LoadAssetAtPath<Material>(screenPath);
            if (screen == null)
            {
                screen = new Material(Shader.Find("Unlit/Texture"));
                AssetDatabase.CreateAsset(screen, screenPath);
            }
            quad.GetComponent<MeshRenderer>().sharedMaterial = screen;
            var screenComponent = quad.AddComponent<VRCAVProVideoScreen>();
            var ss = new SerializedObject(screenComponent);
            // The player reference is the one object field of the player's type.
            var it = ss.GetIterator();
            while (it.NextVisible(true))
            {
                if (it.propertyType == SerializedPropertyType.ObjectReference && it.type.Contains("VRCAVProVideoPlayer"))
                    it.objectReferenceValue = player;
            }
            ss.FindProperty("materialIndex").intValue = 0;
            ss.FindProperty("textureProperty").stringValue = "_MainTex";
            ss.FindProperty("useSharedMaterial").boolValue = true;
            ss.ApplyModifiedPropertiesWithoutUndo();
        }
        else
        {
            player = go.AddComponent<VRCUnityVideoPlayer>();
            var so = new SerializedObject(player);
            so.FindProperty("renderMode").intValue = 0; // RenderTexture
            so.FindProperty("targetTexture").objectReferenceValue = video;
            so.ApplyModifiedPropertiesWithoutUndo();
        }
        var loop = new SerializedObject(player);
        loop.FindProperty("loop").boolValue = false;
        loop.ApplyModifiedPropertiesWithoutUndo();

        var probe = UdonSharpUndo.AddComponent<DownProbe>(go);
        probe.player = player;
        probe.video = video;
        probe.screenMaterial = screen;
        probe.decode = mat;
        probe.decoded = decoded;
        probe.urls = urls;
        probe.blockSizes = blocks;
        probe.levels = levels;
        probe.seeds = seeds;
        UdonSharpEditorUtility.CopyProxyToUdon(probe);
        AssetDatabase.SaveAssets();
        Debug.Log("[ProbeSceneBuilder] down probe (" + (avpro ? "AVPro" : "Unity") + ") with " + n + " videos " + w + "x" + h);
    }

    static RenderTexture EnsureRenderTexture()
    {
        var rt = AssetDatabase.LoadAssetAtPath<RenderTexture>(TexturePath);
        if (rt != null) return rt;
        rt = new RenderTexture(640, 360, 0, RenderTextureFormat.ARGB32);
        AssetDatabase.CreateAsset(rt, TexturePath);
        return rt;
    }
}
