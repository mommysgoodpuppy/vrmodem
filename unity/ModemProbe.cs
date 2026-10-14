// Probe driver for the video-player side channel experiments.
// Wire UI buttons to the public methods (UdonBehaviour.SendCustomEvent).
// Every action is logged as "[ModemProbe] <utc time> ..." in the VRChat output
// log, to be lined up with the probe server's JSONL log.
//
// Deliberately unsynced: only the local player loads the probe URL.

using System;
using UdonSharp;
using UnityEngine;
using VRC.SDK3.Components;
using VRC.SDK3.Components.Video;
using VRC.SDK3.Video.Components.Base;
using VRC.SDKBase;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class ModemProbe : UdonSharpBehaviour
{
    public BaseVRCVideoPlayer player;
    public VRCUrlInputField urlInput;

    [Header("Seek pattern")]
    public float[] seekTargets = { 10f, 60f, 20f, 100f, 5f, 75f, 40f, 115f };
    public float seekInterval = 1f;
    public bool randomSeeks;

    [Header("Pause pattern")]
    public float pauseInterval = 1f;
    public int pauseSteps = 16;

    [Header("Sampling")]
    public float sampleInterval = 0.25f;

    // Bumped on stop so pending delayed events from an old run do nothing.
    private int _run;
    private int _step;
    private bool _sampling;

    private void Log(string msg)
    {
        Debug.Log("[ModemProbe] " + DateTime.UtcNow.ToString("HH:mm:ss.fff") + " " + msg);
    }

    private string State()
    {
        return "pos=" + player.GetTime().ToString("F3") + " playing=" + player.IsPlaying + " ready=" + player.IsReady;
    }

    // --- basic controls ---

    public void LoadFromInput()
    {
        VRCUrl url = urlInput.GetUrl();
        Log("load " + url.Get());
        player.LoadURL(url);
    }

    public void Play() { Log("play " + State()); player.Play(); }
    public void Pause() { Log("pause " + State()); player.Pause(); }
    public void SeekBack() { SeekTo(player.GetTime() - 10f); }
    public void SeekForward() { SeekTo(player.GetTime() + 10f); }

    private void SeekTo(float t)
    {
        t = Mathf.Clamp(t, 0f, Mathf.Max(0f, player.GetDuration() - 0.1f));
        Log("seek " + t.ToString("F3") + " from " + State());
        player.SetTime(t);
    }

    // --- patterns ---

    public void StopPatterns()
    {
        _run++;
        Log("stop patterns " + State());
    }

    public void StartSeekPattern()
    {
        _run++;
        _step = 0;
        Log("seek pattern start run=" + _run);
        _SeekStep();
    }

    public void _SeekStep()
    {
        int run = _run;
        if (_step >= seekTargets.Length && !randomSeeks)
        {
            Log("seek pattern done run=" + run);
            return;
        }
        float t = randomSeeks
            ? UnityEngine.Random.Range(0f, player.GetDuration())
            : seekTargets[_step];
        SeekTo(t);
        _step++;
        _ScheduleIfCurrent(run, nameof(_SeekStep), seekInterval);
    }

    public void StartPausePattern()
    {
        _run++;
        _step = 0;
        Log("pause pattern start run=" + _run);
        _PauseStep();
    }

    public void _PauseStep()
    {
        int run = _run;
        if (_step >= pauseSteps)
        {
            Log("pause pattern done run=" + run);
            player.Play();
            return;
        }
        // Even steps pause, odd steps play.
        if (_step % 2 == 0) Pause(); else Play();
        _step++;
        _ScheduleIfCurrent(run, nameof(_PauseStep), pauseInterval);
    }

    // Delayed events can't carry arguments. Count pending dispatches and act
    // only on the last one, so a stopped or replaced run's leftover dispatch
    // never fires an extra step.
    private int _pending;
    private int _pendingRun;
    private string _pendingEvent;

    private void _ScheduleIfCurrent(int run, string evt, float delay)
    {
        _pending++;
        _pendingRun = run;
        _pendingEvent = evt;
        SendCustomEventDelayedSeconds(nameof(_Dispatch), delay);
    }

    public void _Dispatch()
    {
        _pending--;
        if (_pending > 0 || _pendingRun != _run) return;
        SendCustomEvent(_pendingEvent);
    }

    // --- sampling: position over time shows seek latency and stalls ---

    public void ToggleSampling()
    {
        _sampling = !_sampling;
        Log("sampling " + _sampling);
        if (_sampling) SendCustomEventDelayedSeconds(nameof(_Sample), 0f);
    }

    public void _Sample()
    {
        if (!_sampling) return;
        Log("sample " + State());
        SendCustomEventDelayedSeconds(nameof(_Sample), sampleInterval);
    }

    // --- player events ---

    public override void OnVideoReady() { Log("event ready dur=" + player.GetDuration().ToString("F3")); }
    public override void OnVideoStart() { Log("event start " + State()); }
    public override void OnVideoPlay() { Log("event play " + State()); }
    public override void OnVideoPause() { Log("event pause " + State()); }
    public override void OnVideoEnd() { Log("event end"); }
    public override void OnVideoLoop() { Log("event loop"); }
    public override void OnVideoError(VideoError videoError) { Log("event error " + videoError); }
}
