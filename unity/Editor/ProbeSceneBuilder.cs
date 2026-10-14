// Builds the probe scene: a VRCWorld, a floor, and two bare video players
// (AVPro, Unity), each driven by its own unsynced ModemProbe. Nothing is meant
// to be looked at; results are in the logs. Regenerates
// Assets/Scenes/ModemProbe.unity from scratch every run.
//
// The probe URL is baked in at build time (Udon can't construct URLs):
// VRMODEM_URL env var, default below.
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
    const string DefaultUrl = "http://127.0.0.1:8787/v/{session}/probe.mp4?fps=60&seconds=3600&lead=30&pace=1";

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

        var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);

        var world = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(WorldPrefab));
        PrefabUtility.UnpackPrefabInstance(world, PrefabUnpackMode.Completely, InteractionMode.AutomatedAction);
        GameObject.CreatePrimitive(PrimitiveType.Plane).name = "Floor";

        var avpro = new GameObject("Probe AVPro");
        AddProbe(avpro, avpro.AddComponent<VRCAVProVideoPlayer>(), PlayerUrl(url, "avpro"), 0f);

        // Unity player renders into a RenderTexture: no screen needed, and it
        // is the readback source for downlink experiments later.
        var unity = new GameObject("Probe Unity");
        var unityPlayer = unity.AddComponent<VRCUnityVideoPlayer>();
        var so = new SerializedObject(unityPlayer);
        so.FindProperty("renderMode").intValue = 0; // RenderTexture
        so.FindProperty("targetTexture").objectReferenceValue = EnsureRenderTexture();
        so.ApplyModifiedPropertiesWithoutUndo();
        AddProbe(unity, unityPlayer, PlayerUrl(url, "unity"), 8f);

        System.IO.Directory.CreateDirectory("Assets/Scenes");
        EditorSceneManager.SaveScene(scene, ScenePath);
        Debug.Log("[ProbeSceneBuilder] saved " + ScenePath + " url=" + url);
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

    static void AddProbe(GameObject go, BaseVRCVideoPlayer player, string url, float startDelay)
    {
        var probe = UdonSharpUndo.AddComponent<ModemProbe>(go);
        probe.player = player;
        probe.url = new VRCUrl(url);
        probe.startDelay = startDelay;
        var uri = new System.Uri(url);
        if (uri.AbsolutePath.StartsWith("/v/"))
        {
            int fps = 60;
            foreach (var param in uri.Query.TrimStart('?').Split('&'))
                if (param.StartsWith("fps=")) fps = int.Parse(param.Substring(4));
            probe.seekFps = fps;
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
