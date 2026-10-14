// GPU check against fixtures made by server/check_downlink_shader.ts.
using System;
using System.IO;
using UnityEditor;
using UnityEngine;

public static class DownlinkShaderCheck
{
    [Serializable] public class Case
    {
        public int w, h, block, levels, seed, frame, errors, count, firstSymbol;
        public string file;
        public bool flipped, valid, checkFirst;
    }
    [Serializable] public class Cases { public Case[] cases; }

    public static void Run()
    {
        try
        {
            var path = Environment.GetEnvironmentVariable("VRMODEM_DOWNLINK_CASES");
            var cases = JsonUtility.FromJson<Cases>(File.ReadAllText(path)).cases;
            var shader = Shader.Find("vrmodem/Downlink");
            if (shader == null || !shader.isSupported) throw new Exception("Downlink shader unavailable");
            var material = new Material(shader);
            try { foreach (var c in cases) Check(material, c); }
            finally { UnityEngine.Object.DestroyImmediate(material); }
            Debug.Log("[DownlinkShaderCheck] PASS " + cases.Length + " cases");
        }
        catch (Exception e)
        {
            Debug.LogException(e);
            if (Application.isBatchMode) EditorApplication.Exit(1);
            throw;
        }
    }

    static void Check(Material material, Case c)
    {
        var bytes = File.ReadAllBytes(c.file);
        var rgba = new byte[bytes.Length * 4];
        for (int i = 0; i < bytes.Length; i++)
        {
            rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = bytes[i];
            rgba[4 * i + 3] = 255;
        }
        // Raw fixtures are top-first; Unity uploads its first row at the bottom.
        var input = new Texture2D(c.w, c.h, TextureFormat.RGBA32, false, true);
        int cols = c.w / c.block, rows = (c.h - 16) / c.block;
        var target = new RenderTexture(cols, rows + 1, 0, RenderTextureFormat.ARGBFloat, RenderTextureReadWrite.Linear);
        var readback = new Texture2D(cols, rows + 1, TextureFormat.RGBAFloat, false, true);
        var previous = RenderTexture.active;
        try
        {
            input.LoadRawTextureData(rgba);
            input.Apply(false);
            material.SetInt("_Block", c.block);
            material.SetInt("_Levels", c.levels);
            material.SetInt("_Seed", c.seed);
            target.Create();
            Graphics.Blit(input, target, material, 0);
            RenderTexture.active = target;
            readback.ReadPixels(new Rect(0, 0, cols, rows + 1), 0, 0);
            readback.Apply();
            var data = readback.GetPixels();
            var header = data[rows * cols];
            if (header.r != c.frame || header.g != (c.valid ? 1 : 0) || header.a != c.count ||
                (c.valid && header.b != (c.flipped ? 0 : 1)))
                throw new Exception("Header mismatch: " + c.file + " got " + header.ToString("F0"));
            for (int x = 1; x < cols; x++)
                if (data[rows * cols + x] != Color.clear) throw new Exception("Nonzero padding");
            int errors = 0;
            for (int y = 0; y < rows; y++) for (int x = 0; x < cols; x++)
            {
                var value = data[(rows - 1 - y) * cols + x];
                if (!c.valid)
                {
                    if (value != Color.clear) throw new Exception("Invalid frame produced data");
                    continue;
                }
                uint expected = Hash(Hash((uint)c.frame ^ (unchecked((uint)c.seed * 0x9e3779b9u))) + (uint)(y * cols + x)) % (uint)c.levels;
                if (value.g != expected || value.a != 1 || value.r < 0 || value.r >= c.levels ||
                    value.r != Mathf.Floor(value.r) || value.b != (value.r != value.g ? 1 : 0))
                    throw new Exception("Symbol mismatch: " + c.file + " block " + (y * cols + x));
                if (c.checkFirst && x == 0 && y == 0 && value.r != c.firstSymbol)
                    throw new Exception("Centre averaging/tie mismatch: got " + value.r);
                errors += (int)value.b;
            }
            if (errors != c.errors) throw new Exception("Error count mismatch: " + errors + " expected " + c.errors);
            Debug.Log("[DownlinkShaderCheck] frame=" + c.frame + " b=" + c.block + " levels=" + c.levels + " errors=" + errors);
        }
        finally
        {
            RenderTexture.active = previous;
            target.Release();
            UnityEngine.Object.DestroyImmediate(target);
            UnityEngine.Object.DestroyImmediate(input);
            UnityEngine.Object.DestroyImmediate(readback);
        }
    }
    static uint Hash(uint x)
    {
        unchecked { x = (x ^ (x >> 16)) * 0x7feb352du; x = (x ^ (x >> 15)) * 0x846ca68bu; return x ^ (x >> 16); }
    }
}
