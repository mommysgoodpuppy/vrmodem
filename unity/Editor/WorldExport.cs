// Headless world export: regenerates the probe scene, then runs the SDK's
// local-test export (the build half of Build & Test) and writes the .vrcw
// path to <project>/Logs/vrmodem-last-build.txt for the launcher.
//
// Batch: Unity -batchmode -quit -projectPath <proj> -executeMethod WorldExport.Build

using System;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRC.SDK3.Editor.Builder;

public static class WorldExport
{
    const string ScenePath = "Assets/Scenes/ModemProbe.unity";
    const string ResultPath = "Logs/vrmodem-last-build.txt";

    public static void Build()
    {
        try
        {
            ProbeSceneBuilder.Build();
            EditorSceneManager.OpenScene(ScenePath);

            string built = null;
            string error = null;
            var builder = (VRCWorldBuilder)Activator.CreateInstance(typeof(VRCWorldBuilder), true);
            builder.OnBuildProgress += (_, msg) => Debug.Log("[WorldExport] progress " + msg);
            builder.OnBuildSuccess += (_, r) => built = r.Item1;
            builder.OnBuildError += (_, msg) => error = msg;
            bool ok = builder.ExportSceneResource();
            Debug.Log("[WorldExport] ok=" + ok + " built=" + built + " error=" + error);
            if (!ok || string.IsNullOrEmpty(built)) throw new Exception("export failed: " + error);

            System.IO.File.WriteAllText(ResultPath, built + "\n");
            Debug.Log("[WorldExport] wrote " + ResultPath);
        }
        catch (Exception e)
        {
            Debug.LogException(e);
            if (Application.isBatchMode) EditorApplication.Exit(1);
            throw;
        }
    }
}
