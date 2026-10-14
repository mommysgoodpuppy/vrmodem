// Downlink probe: plays each test video (server/gen_downlink.ts) on a Unity
// video player, decodes every frame with Downlink.shader, and logs what the
// world actually received.
//
// Every frame a one-texel readback of the decoded texture's metadata gives
// the frame number ("down N meta frame=F flip=B"). Meanwhile whole decoded
// textures are read back one at a time and their error flags summed a slice
// per frame, so Udon never stalls ("down N frame=F errors=E blocks=S").
// Logged as "[ModemProbe] <utc time> <object name> ..." like ModemProbe.

using System;
using UdonSharp;
using UnityEngine;
using VRC.SDK3.Rendering;
using VRC.SDK3.Video.Components.Base;
using VRC.SDKBase;
using VRC.Udon.Common.Interfaces;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class DownProbe : UdonSharpBehaviour
{
    public BaseVRCVideoPlayer player;
    public RenderTexture video;        // the player's target
    public Material decode;            // vrmodem/Downlink
    public RenderTexture[] decoded;    // per config: cols x (rows + 1), ARGBFloat
    public VRCUrl[] urls;
    public int[] blockSizes, levels, seeds;
    public float startDelay = 2f;
    // URL loads are rate-limited; leave room between configs.
    public float gap = 6f;
    public int texelsPerFrame = 6000;

    private int _config = -1;
    private bool _playing, _metaPending, _bulkPending, _summing;
    private float[] _meta = new float[4];
    private float[] _bulk = new float[0];
    private int _sumAt, _sumEnd, _errors, _bulkFrame, _lastMeta = -2;

    private void Log(string msg)
    {
        Debug.Log("[ModemProbe] " + DateTime.UtcNow.ToString("HH:mm:ss.fff") + " " + gameObject.name + " " + msg);
    }

    private void Start()
    {
        SendCustomEventDelayedSeconds(nameof(_Next), startDelay);
    }

    public void _Next()
    {
        _playing = false;
        _config++;
        if (_config >= urls.Length)
        {
            Log("probe done");
            return;
        }
        decode.SetInt("_Block", blockSizes[_config]);
        decode.SetInt("_Levels", levels[_config]);
        decode.SetInt("_Seed", seeds[_config]);
        int n = decoded[_config].width * decoded[_config].height * 4;
        if (_bulk.Length < n) _bulk = new float[n];
        _lastMeta = -2;
        Log("down " + _config + " load " + urls[_config].Get());
        player.LoadURL(urls[_config]);
    }

    public override void OnVideoReady()
    {
        Log("down " + _config + " ready dur=" + player.GetDuration().ToString("F3"));
        player.Play();
        _playing = true;
    }

    public override void OnVideoEnd()
    {
        Log("down " + _config + " end");
        _playing = false;
        SendCustomEventDelayedSeconds(nameof(_Next), gap);
    }

    public override void OnVideoError(VRC.SDK3.Components.Video.VideoError videoError)
    {
        Log("down " + _config + " failed " + videoError);
        _playing = false;
        SendCustomEventDelayedSeconds(nameof(_Next), gap);
    }

    private void Update()
    {
        if (_summing) Sum();
        if (!_playing) return;
        RenderTexture target = decoded[_config];
        VRCGraphics.Blit(video, target, decode, 0);
        // The metadata texel is the top-left of the picture: the texture's last row.
        if (!_metaPending)
        {
            VRCAsyncGPUReadback.Request(target, 0, 0, 1, target.height - 1, 1, 0, 1, (IUdonEventReceiver)this);
            _metaPending = true;
        }
        if (!_bulkPending && !_summing)
        {
            VRCAsyncGPUReadback.Request(target, 0, (IUdonEventReceiver)this);
            _bulkPending = true;
        }
    }

    public override void OnAsyncGpuReadbackComplete(VRCAsyncGPUReadbackRequest request)
    {
        if (request.width == 1 && request.height == 1)
        {
            _metaPending = false;
            if (request.hasError || !request.TryGetData(_meta, 0) || _meta[1] < 0.5f) return;
            int frame = (int)_meta[0];
            if (frame == _lastMeta) return;
            _lastMeta = frame;
            Log("down " + _config + " meta frame=" + frame + " flip=" + (_meta[2] > 0.5f ? 1 : 0));
            return;
        }
        _bulkPending = false;
        if (request.hasError || !request.TryGetData(_bulk, 0)) return;
        int w = request.width, h = request.height;
        int top = (h - 1) * w * 4;
        if (_bulk[top + 1] < 0.5f) return;
        _bulkFrame = (int)_bulk[top];
        // Payload rows are the texture's rows 0 .. h - 2; the error flag is blue.
        _sumAt = 0;
        _sumEnd = (h - 1) * w;
        _errors = 0;
        _summing = true;
    }

    private void Sum()
    {
        int end = Mathf.Min(_sumEnd, _sumAt + texelsPerFrame);
        int errors = _errors;
        for (int i = _sumAt; i < end; i++) errors += (int)_bulk[i * 4 + 2];
        _errors = errors;
        _sumAt = end;
        if (_sumAt < _sumEnd) return;
        _summing = false;
        Log("down " + _config + " frame=" + _bulkFrame + " errors=" + _errors + " blocks=" + _sumEnd);
    }
}
