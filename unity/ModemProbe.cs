// Automatic probe for the video-player side channel experiments.
// On start (after startDelay) it loads `url`, plays, samples the position,
// runs the seek pattern, then the pause pattern, then stops. Every action is
// logged as "[ModemProbe] <utc time> <object name> ..." in the VRChat output
// log, to be lined up with the probe server's JSONL log.
//
// Deliberately unsynced: only the local player loads the probe URL.

using System;
using UdonSharp;
using UnityEngine;
using VRC.SDK3.Components.Video;
using VRC.SDK3.Video.Components.Base;
using VRC.SDKBase;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class ModemProbe : UdonSharpBehaviour
{
    public BaseVRCVideoPlayer player;
    public VRCUrl url;
    // URL loads are rate-limited across the world, so stagger players.
    public float startDelay;
    public float settleSeconds = 5f;

    [Header("Seek pattern")]
    public float[] seekTargets = { 10f, 60f, 20f, 100f, 5f, 75f, 40f, 115f };
    public float seekInterval = 1f;

    [Header("Pause pattern")]
    public float pauseInterval = 1f;
    public int pauseSteps = 16;

    [Header("Sampling")]
    public float sampleInterval = 0.25f;

    private int _step;
    private bool _sampling;
    private bool _failed;

    private void Log(string msg)
    {
        Debug.Log("[ModemProbe] " + DateTime.UtcNow.ToString("HH:mm:ss.fff") + " " + gameObject.name + " " + msg);
    }

    private string State()
    {
        return "pos=" + player.GetTime().ToString("F3") + " playing=" + player.IsPlaying + " ready=" + player.IsReady;
    }

    private void Start()
    {
        SendCustomEventDelayedSeconds(nameof(_Load), startDelay);
    }

    public void _Load()
    {
        Log("load " + url.Get());
        player.LoadURL(url);
    }

    // --- sequence: ready -> play + sample -> seeks -> pauses -> done ---

    public override void OnVideoReady()
    {
        Log("event ready dur=" + player.GetDuration().ToString("F3"));
        player.Play();
        _sampling = true;
        _Sample();
        SendCustomEventDelayedSeconds(nameof(_SeekStep), settleSeconds);
    }

    public void _SeekStep()
    {
        if (_failed) return;
        if (_step >= seekTargets.Length)
        {
            Log("seeks done " + State());
            _step = 0;
            SendCustomEventDelayedSeconds(nameof(_PauseStep), settleSeconds);
            return;
        }
        float t = Mathf.Clamp(seekTargets[_step], 0f, Mathf.Max(0f, player.GetDuration() - 0.1f));
        Log("seek " + t.ToString("F3") + " from " + State());
        player.SetTime(t);
        _step++;
        SendCustomEventDelayedSeconds(nameof(_SeekStep), seekInterval);
    }

    public void _PauseStep()
    {
        if (_failed) return;
        if (_step >= pauseSteps)
        {
            player.Play();
            Log("pauses done " + State());
            SendCustomEventDelayedSeconds(nameof(_Finish), settleSeconds);
            return;
        }
        // Even steps pause, odd steps play.
        if (_step % 2 == 0)
        {
            Log("pause " + State());
            player.Pause();
        }
        else
        {
            Log("play " + State());
            player.Play();
        }
        _step++;
        SendCustomEventDelayedSeconds(nameof(_PauseStep), pauseInterval);
    }

    public void _Finish()
    {
        _sampling = false;
        player.Stop();
        Log("probe done");
    }

    // Position over time shows seek latency and stalls.
    public void _Sample()
    {
        if (!_sampling) return;
        Log("sample " + State());
        SendCustomEventDelayedSeconds(nameof(_Sample), sampleInterval);
    }

    // --- player events ---

    public override void OnVideoStart() { Log("event start " + State()); }
    public override void OnVideoPlay() { Log("event play " + State()); }
    public override void OnVideoPause() { Log("event pause " + State()); }
    public override void OnVideoEnd() { Log("event end"); }
    public override void OnVideoLoop() { Log("event loop"); }

    public override void OnVideoError(VideoError videoError)
    {
        _failed = true;
        _sampling = false;
        Log("event error " + videoError);
    }
}
