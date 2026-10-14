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
    // Zero preserves ordinary media seeks at seekInterval. Virtual media
    // instead seeks random frames in [1, seekFrames), seeksPerInterval at each
    // of seekIntervals. 0 means one seek every Udon frame, and -k means k seeks
    // within each Udon frame. WMF requests the first
    // sample starting at or after the seek time, ceil(t * fps), so frame N is
    // aimed at (N - 0.5) / fps.
    public int seekFps;
    public int seekFrames;
    public float[] seekIntervals = { 0.1f, 0f, -2f, -4f, -8f };
    public int seeksPerInterval = 400;

    [Header("Pause pattern")]
    public float pauseInterval = 1f;
    public int pauseSteps = 16;

    [Header("Matrix")]
    // When set, the probe only loads each URL in turn, matrixInterval apart,
    // and logs whether it became ready or failed. Used to find which virtual
    // media parameters the player accepts.
    public VRCUrl[] matrixUrls = new VRCUrl[0];
    public float matrixInterval = 12f;

    [Header("Sampling")]
    public float sampleInterval = 0.25f;

    private int _step;
    private bool _sampling;
    private bool _failed;
    private int _matrix = -1;

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
        if (matrixUrls.Length > 0) SendCustomEventDelayedSeconds(nameof(_MatrixStep), startDelay);
        else SendCustomEventDelayedSeconds(nameof(_Load), startDelay);
    }

    public void _MatrixStep()
    {
        _matrix++;
        if (_matrix >= matrixUrls.Length)
        {
            player.Stop();
            Log("probe done");
            return;
        }
        Log("matrix " + _matrix + " load " + matrixUrls[_matrix].Get());
        player.LoadURL(matrixUrls[_matrix]);
        SendCustomEventDelayedSeconds(nameof(_MatrixStep), matrixInterval);
    }

    public void _Load()
    {
        Log("load " + url.Get());
        player.LoadURL(url);
    }

    // --- sequence: ready -> play + sample -> seeks -> pauses -> done ---

    public override void OnVideoReady()
    {
        if (_matrix >= 0)
        {
            Log("matrix " + _matrix + " ready dur=" + player.GetDuration().ToString("F3"));
            return;
        }
        Log("event ready dur=" + player.GetDuration().ToString("F3"));
        player.Play();
        _sampling = true;
        _Sample();
        SendCustomEventDelayedSeconds(nameof(_SeekStep), settleSeconds);
    }

    public void _SeekStep()
    {
        if (_failed) return;
        bool virtualSeeks = seekFps > 0 && seekFrames > 1;
        int total = virtualSeeks ? seekIntervals.Length * seeksPerInterval : seekTargets.Length;
        if (_step >= total)
        {
            Log("seeks done " + State());
            _step = 0;
            SendCustomEventDelayedSeconds(nameof(_PauseStep), settleSeconds);
            return;
        }
        float interval = seekInterval;
        if (virtualSeeks)
        {
            interval = seekIntervals[_step / seeksPerInterval];
            int burst = interval < 0f ? Mathf.RoundToInt(-interval) : 1;
            for (int i = 0; i < burst && _step < total; i++)
            {
                int frame = UnityEngine.Random.Range(1, seekFrames);
                // Float32 loses whole frames past 2^24; do the division in double.
                float t = (float)((frame - 0.5) / seekFps);
                Log("seek " + t.ToString("F6") + " frame=" + frame + " interval=" + interval.ToString("F3") + " from " + State());
                player.SetTime(t);
                if (i + 1 < burst) _step++;
            }
        }
        else
        {
            float t = Mathf.Clamp(seekTargets[_step], 0f, Mathf.Max(0f, player.GetDuration() - 0.1f));
            Log("seek " + t.ToString("F6") + " from " + State());
            player.SetTime(t);
        }
        _step++;
        if (interval > 0f) SendCustomEventDelayedSeconds(nameof(_SeekStep), interval);
        else SendCustomEventDelayedFrames(nameof(_SeekStep), 1);
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
        if (_matrix >= 0)
        {
            Log("matrix " + _matrix + " failed " + videoError);
            return;
        }
        _failed = true;
        _sampling = false;
        Log("event error " + videoError);
    }
}
