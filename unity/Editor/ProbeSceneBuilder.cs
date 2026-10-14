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
        EnsureProgramAsset();
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
        int lanes;
        if (int.TryParse(System.Environment.GetEnvironmentVariable("VRMODEM_LANES"), out lanes) && lanes > 0)
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

    static void EnsureProgramAsset()
    {
        if (AssetDatabase.LoadAssetAtPath<UdonSharpProgramAsset>(ProgramPath) == null)
        {
            var asset = ScriptableObject.CreateInstance<UdonSharpProgramAsset>();
            asset.sourceCsScript = AssetDatabase.LoadAssetAtPath<MonoScript>(ScriptPath);
            AssetDatabase.CreateAsset(asset, ProgramPath);
            AssetDatabase.SaveAssets();
            Debug.Log("[ProbeSceneBuilder] created " + ProgramPath);
        }
        UdonSharpCompilerV1.CompileSync(new UdonSharpCompileOptions());
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
