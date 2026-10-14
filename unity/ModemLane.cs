// One uplink lane of the modem (MODEM.md): a video player whose seeks the
// gateway reads as symbols. Modem.cs drives it; this takes its player's events.

using UdonSharp;
using UnityEngine;
using VRC.SDK3.Video.Components.Base;
using VRC.SDKBase;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class ModemLane : UdonSharpBehaviour
{
    public BaseVRCVideoPlayer player;
    public VRCUrl url;
    public float retry = 6f;

    private Modem modem;
    private int index;

    public void Init(Modem m, int i)
    {
        modem = m;
        index = i;
    }

    public void LoadAfter(float seconds) { SendCustomEventDelayedSeconds(nameof(_Load), seconds); }

    public void _Load()
    {
        Debug.Log("[Modem] lane " + index + " load " + url.Get());
        player.LoadURL(url);
    }

    // The lane's video is 60 fps: frame N starts at N / 60, aimed at its middle.
    public void Seek(int frame) { player.SetTime((float)((frame - 0.5) / 60.0)); }

    public override void OnVideoReady()
    {
        player.Play();
        modem.LaneReady(index);
    }

    public override void OnVideoError(VRC.SDK3.Components.Video.VideoError videoError)
    {
        Debug.Log("[Modem] lane " + index + " failed " + videoError + ", again in " + retry + " s");
        modem.LaneLost(index);
        LoadAfter(retry);
    }

    public override void OnVideoEnd()
    {
        modem.LaneLost(index);
        LoadAfter(retry);
    }
}
