// The world's half of the modem (MODEM.md; server/modem/client.ts is the
// reference and this must agree with it bit for bit). IP packets go in with
// Send() and come out of Receive(); in between, lane players seek and the
// downlink player's frames are read back as bytes (ModemPack.shader).
//
// Put this on the downlink player's object (it takes that player's events),
// and a ModemLane on each lane player's.
// Logs "[Modem] <utc time> ..." lines: loads, readiness, counts every 5 s.

using System;
using UdonSharp;
using UnityEngine;
using VRC.SDK3.Rendering;
using VRC.SDK3.Video.Components.Base;
using VRC.SDKBase;
using VRC.Udon.Common.Interfaces;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class Modem : UdonSharpBehaviour
{
    public BaseVRCVideoPlayer downPlayer;
    public VRCUrl downUrl;
    public RenderTexture downVideo;    // the downlink player's target
    public Material pack;              // vrmodem/ModemPack, _Block 8, _Levels 4
    public RenderTexture packed;       // 1 + bytes / 4 by 1, ARGB32, linear
    public ModemLane[] lanes;
    public int address = 0x0a000001;   // 10.0.0.1
    public float startDelay = 2f;
    public float loadGap = 6f;         // VRChat rate-limits URL loads
    public int readbacksInFlight = 3;

    private const int ChunkBits = 15, SeqMod = 126, Window = 63, Slots = 64;
    private const int Queue = 4096;     // chunks waiting, per lane
    private const int Rto = 2000, AckEvery = 100;
    private const int Mtu = 576, RxQueue = 64;
    private const int U24 = 1 << 24, Seen = 1024;

    private int laneCount, nonce;
    private bool[] ready;
    // Per lane: chunks waiting (a ring), and in flight by absolute number & 63.
    private int[] queue, qHead, qTail;
    private int[] slotChunk, slotOrder;
    private bool[] slotLive, slotResend;
    private int[] resend, rsHead, rsTail;
    private int[] laneBase, laneNext, laneOrder, laneProgress;
    // Downlink.
    private bool downReady;
    private int readbacks, lastFrame = -1;
    private byte[] frame, packedBytes;
    private int cumulative, acked = -1, ackAt = -100000;
    private bool[] seen = new bool[Seen];
    private byte[] rxBuf = new byte[RxQueue * Mtu];
    private int[] rxLen = new int[RxQueue];
    private int rxHead, rxTail;
    private byte[] scratch = new byte[2 + Mtu];
    // Counts.
    public int sent, received, seeks, resends, frames, badFrames, duplicates, dropped;
    private float statsAt;

    private void Log(string msg)
    {
        Debug.Log("[Modem] " + DateTime.UtcNow.ToString("HH:mm:ss.fff") + " " + msg);
    }

    private int Now() { return (int)(Time.realtimeSinceStartup * 1000f); }

    private void Start()
    {
        laneCount = lanes.Length;
        ready = new bool[laneCount];
        queue = new int[laneCount * Queue];
        qHead = new int[laneCount];
        qTail = new int[laneCount];
        slotChunk = new int[laneCount * Slots];
        slotOrder = new int[laneCount * Slots];
        slotLive = new bool[laneCount * Slots];
        slotResend = new bool[laneCount * Slots];
        resend = new int[laneCount * Slots];
        rsHead = new int[laneCount];
        rsTail = new int[laneCount];
        laneBase = new int[laneCount];
        laneNext = new int[laneCount];
        laneOrder = new int[laneCount];
        laneProgress = new int[laneCount];
        frame = new byte[(packed.width - 1) * 4];
        packedBytes = new byte[packed.width * 4];
        nonce = UnityEngine.Random.Range(1, int.MaxValue);
        for (int i = 0; i < laneCount; i++) lanes[i].Init(this, i);
        SendCustomEventDelayedSeconds(nameof(_LoadDown), startDelay);
    }

    // ---- loads: the downlink, then the lanes, one every loadGap ----

    public void _LoadDown()
    {
        Log("load down " + downUrl.Get());
        downPlayer.LoadURL(downUrl);
        for (int i = 0; i < laneCount; i++) lanes[i].LoadAfter(loadGap * (i + 1));
    }

    public override void OnVideoReady()
    {
        Log("down ready");
        downPlayer.Play();
        downReady = true;
    }

    public override void OnVideoError(VRC.SDK3.Components.Video.VideoError videoError)
    {
        Log("down failed " + videoError + ", again in " + loadGap + " s");
        downReady = false;
        SendCustomEventDelayedSeconds(nameof(_ReloadDown), loadGap);
    }

    public override void OnVideoEnd()
    {
        Log("down ended, again");
        downReady = false;
        SendCustomEventDelayedSeconds(nameof(_ReloadDown), loadGap);
    }

    public void _ReloadDown() { downPlayer.LoadURL(downUrl); }

    // A lane's player is ready (its sequence starts from 0 at the gateway) or gone.
    public void LaneReady(int lane)
    {
        ResetLane(lane);
        ready[lane] = true;
        Log("lane " + lane + " ready");
        byte[] hello = new byte[8];
        PutU32(hello, 0, nonce);
        PutU32(hello, 4, address);
        Write(lane, 3, hello, 0, 8);
    }

    public void LaneLost(int lane)
    {
        ready[lane] = false;
        ResetLane(lane);
    }

    private void ResetLane(int l)
    {
        qHead[l] = qTail[l] = 0;
        rsHead[l] = rsTail[l] = 0;
        laneBase[l] = laneNext[l] = laneOrder[l] = 0;
        for (int i = 0; i < Slots; i++) { slotLive[l * Slots + i] = false; slotResend[l * Slots + i] = false; }
    }

    // ---- the API ----

    // True once the gateway has heard this run's hello.
    public bool Connected() { return lastFrame >= 0 && helloHeard; }
    private bool helloHeard;

    // An IPv4 packet out: false when no lane has room.
    public bool Send(byte[] from, int at, int length)
    {
        if (length < 20 || length > Mtu) return false;
        int lane = Least();
        // (room for the packet's chunks and some for acks)
        if (lane < 0 || Queue - 1 - Waiting(lane) < (length + 2) * 8 / ChunkBits + 16) { dropped++; return false; }
        Write(lane, 1, from, at, length);
        sent++;
        return true;
    }

    // The next packet in: its length (0: none), its bytes at `into[at]`.
    public int Receive(byte[] into, int at)
    {
        if (rxHead == rxTail) return 0;
        int length = rxLen[rxHead];
        Buffer.BlockCopy(rxBuf, rxHead * Mtu, into, at, length);
        rxHead = (rxHead + 1) % RxQueue;
        return length;
    }

    // ---- uplink ----

    private int Waiting(int l) { return (qTail[l] - qHead[l] + Queue) % Queue; }
    private int Load(int l) { return Waiting(l) + laneNext[l] - laneBase[l]; }

    private int Least()
    {
        int best = -1;
        for (int i = 0; i < laneCount; i++)
            if (ready[i] && (best < 0 || Load(i) < Load(best))) best = i;
        return best;
    }

    // A link frame (MODEM.md): header, payload, as 15-bit chunks MSB first.
    private void Write(int l, int type, byte[] from, int at, int length)
    {
        scratch[0] = (byte)((type << 4) | (length >> 8));
        scratch[1] = (byte)(length & 255);
        Buffer.BlockCopy(from, at, scratch, 2, length);
        int acc = 0, bits = 0, n = length + 2, tail = qTail[l], q = l * Queue;
        for (int i = 0; i < n; i++)
        {
            acc = (acc << 8) | scratch[i];
            bits += 8;
            if (bits >= ChunkBits)
            {
                bits -= ChunkBits;
                queue[q + tail] = (acc >> bits) & 0x7fff;
                tail = (tail + 1) % Queue;
                acc &= (1 << bits) - 1;
            }
        }
        if (bits > 0)
        {
            queue[q + tail] = (acc << (ChunkBits - bits)) & 0x7fff;
            tail = (tail + 1) % Queue;
        }
        qTail[l] = tail;
    }

    // The symbol lane l seeks to now, or -1.
    private int Poll(int l, int now)
    {
        int s0 = l * Slots;
        if (laneBase[l] < laneNext[l] && now - laneProgress[l] > Rto && rsHead[l] == rsTail[l])
        {
            Resend(l, laneBase[l]);
            laneProgress[l] = now;
        }
        int abs = -1;
        while (rsHead[l] != rsTail[l])
        {
            int a = resend[s0 + rsHead[l]];
            rsHead[l] = (rsHead[l] + 1) % Slots;
            slotResend[s0 + (a & 63)] = false;
            if (a >= laneBase[l] && a < laneNext[l] && slotLive[s0 + (a & 63)]) { abs = a; break; }
        }
        if (abs >= 0) resends++;
        else
        {
            if (qHead[l] == qTail[l] || laneNext[l] - laneBase[l] >= Window) return -1;
            abs = laneNext[l]++;
            if (laneBase[l] == abs) laneProgress[l] = now;
            int s = s0 + (abs & 63);
            slotChunk[s] = queue[l * Queue + qHead[l]];
            qHead[l] = (qHead[l] + 1) % Queue;
            slotLive[s] = true;
        }
        slotOrder[s0 + (abs & 63)] = ++laneOrder[l];
        return (abs % SeqMod) * (1 << ChunkBits) + slotChunk[s0 + (abs & 63)];
    }

    private void Resend(int l, int abs)
    {
        int s = l * Slots + (abs & 63);
        if (slotResend[s]) return;
        slotResend[s] = true;
        resend[l * Slots + rsTail[l]] = abs;
        rsTail[l] = (rsTail[l] + 1) % Slots;
    }

    // The gateway's ack of lane l: expected seq, then a 64-bit bitmap at frame[at].
    private void Ack(int l, int expectedSeq, int at, int now)
    {
        int b = laneBase[l], s0 = l * Slots;
        int expected = b + ((expectedSeq - b % SeqMod + SeqMod) % SeqMod);
        if (expected > laneNext[l]) return;
        int newest = 0;
        for (int a = b; a < expected; a++)
        {
            int s = s0 + (a & 63);
            if (slotLive[s] && slotOrder[s] > newest) newest = slotOrder[s];
            slotLive[s] = false;
        }
        if (expected > b) laneProgress[l] = now;
        laneBase[l] = expected;
        for (int i = 0; i < Window; i++)
        {
            if ((frame[at + (i >> 3)] >> (i & 7) & 1) == 0) continue;
            int a = expected + 1 + i;
            if (a >= laneNext[l]) break;
            int s = s0 + (a & 63);
            if (!slotLive[s]) continue;
            if (slotOrder[s] > newest) newest = slotOrder[s];
            slotLive[s] = false;
        }
        // Lanes keep order: a chunk sent before one that arrived is lost.
        for (int a = expected; a < laneNext[l]; a++)
        {
            int s = s0 + (a & 63);
            if (slotLive[s] && slotOrder[s] < newest) Resend(l, a);
        }
    }

    // ---- the frame clock ----

    private void Update()
    {
        int now = Now();
        if (cumulative != acked && now - ackAt >= AckEvery)
        {
            int lane = Least();
            if (lane >= 0)
            {
                if (Queue - 1 - Waiting(lane) < 8) lane = -1;
            }
            if (lane >= 0)
            {
                acked = cumulative;
                ackAt = now;
                byte[] dack = new byte[3];
                dack[0] = (byte)(acked & 255);
                dack[1] = (byte)((acked >> 8) & 255);
                dack[2] = (byte)((acked >> 16) & 255);
                Write(lane, 2, dack, 0, 3);
            }
        }
        for (int l = 0; l < laneCount; l++)
        {
            if (!ready[l]) continue;
            int symbol = Poll(l, now);
            if (symbol < 0) continue;
            seeks++;
            lanes[l].Seek(symbol + 1);
        }
        if (downReady)
        {
            VRCGraphics.Blit(downVideo, packed, pack, 0);
            if (readbacks < readbacksInFlight)
            {
                VRCAsyncGPUReadback.Request(packed, 0, (IUdonEventReceiver)this);
                readbacks++;
            }
        }
        if (Time.time >= statsAt)
        {
            statsAt = Time.time + 5f;
            Log("counts sent=" + sent + " received=" + received + " seeks=" + seeks + " resends=" + resends +
                " frames=" + frames + " bad=" + badFrames + " duplicates=" + duplicates + " dropped=" + dropped +
                " connected=" + Connected());
        }
    }

    public override void OnAsyncGpuReadbackComplete(VRCAsyncGPUReadbackRequest request)
    {
        readbacks--;
        if (request.hasError || !request.TryGetData(packedBytes)) return;
        if (packedBytes[3] != 255) return;
        int number = packedBytes[0] | packedBytes[1] << 8 | packedBytes[2] << 16;
        if (number == lastFrame) return;
        lastFrame = number;
        frames++;
        Buffer.BlockCopy(packedBytes, 4, frame, 0, frame.Length);
        Frame(Now());
    }

    // A downlink frame (MODEM.md) in `frame`.
    private void Frame(int now)
    {
        if (frame[0] != 0x4d || frame[1] != laneCount) { badFrames++; return; }
        if (U32(frame, 2) != nonce) return;   // our hello isn't heard yet
        helloHeard = true;
        int at = 10;
        for (int l = 0; l < laneCount; l++, at += 9)
            if (ready[l]) Ack(l, frame[at], at + 1, now);
        int low = frame[6] | frame[7] << 8 | frame[8] << 16;
        if (After(low, cumulative))
        {
            if ((low - cumulative + U24) % U24 >= Seen) for (int i = 0; i < Seen; i++) seen[i] = false;
            else for (int n = cumulative; n != low; n = (n + 1) % U24) seen[n % Seen] = false;
            cumulative = low;
        }
        while (at + 5 <= frame.Length)
        {
            int number = frame[at] | frame[at + 1] << 8 | frame[at + 2] << 16;
            int length = frame[at + 3] | frame[at + 4] << 8;
            if (length == 0) break;
            if (length < 20 || length > Mtu || at + 5 + length > frame.Length) { badFrames++; break; }
            int d = (number - cumulative + U24) % U24;
            if (d >= Seen || seen[number % Seen]) duplicates++;
            else
            {
                seen[number % Seen] = true;
                Deliver(at + 5, length);
            }
            at += 5 + length;
        }
        while (seen[cumulative % Seen])
        {
            seen[cumulative % Seen] = false;
            cumulative = (cumulative + 1) % U24;
        }
    }

    private void Deliver(int at, int length)
    {
        received++;
        int next = (rxTail + 1) % RxQueue;
        if (next == rxHead) rxHead = (rxHead + 1) % RxQueue;   // full: the oldest goes
        Buffer.BlockCopy(frame, at, rxBuf, rxTail * Mtu, length);
        rxLen[rxTail] = length;
        rxTail = next;
    }

    // a after b, mod 2^24
    private bool After(int a, int b)
    {
        int d = (a - b + U24) % U24;
        return d != 0 && d < U24 / 2;
    }

    private int U32(byte[] b, int at)
    {
        return b[at] | b[at + 1] << 8 | b[at + 2] << 16 | b[at + 3] << 24;
    }

    private void PutU32(byte[] b, int at, int v)
    {
        b[at] = (byte)(v & 255);
        b[at + 1] = (byte)((v >> 8) & 255);
        b[at + 2] = (byte)((v >> 16) & 255);
        b[at + 3] = (byte)((v >> 24) & 255);
    }
}
