// In-world test of the modem: once the gateway has heard the hello, pings a
// host once a second and resolves a name through the gateway's address, then
// logs "probe done". Logged as "[ModemProbe] <utc time> <object name> ...".

using System;
using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class ModemPing : UdonSharpBehaviour
{
    public Modem modem;
    public int target = 0x01010101;     // 1.1.1.1
    public int count = 20;
    public string resolve = "example.com";
    public float timeout = 120f;        // from start, connected or not

    private const int Gateway = 0x0a00fffe;  // 10.0.255.254
    private byte[] packet = new byte[576];
    private byte[] reply = new byte[576];
    private float[] sentAt;
    private int seq, replies, lost;
    private bool connected, dnsSent, dnsDone, done;
    private float startedAt, dnsAt, connectedAt;
    private float rttSum, rttMax;

    private void Log(string msg)
    {
        Debug.Log("[ModemProbe] " + DateTime.UtcNow.ToString("HH:mm:ss.fff") + " " + gameObject.name + " " + msg);
    }

    private void Start()
    {
        sentAt = new float[count + 1];
        startedAt = Time.realtimeSinceStartup;
    }

    private void Update()
    {
        if (done) return;
        float now = Time.realtimeSinceStartup;
        for (int n = modem.Receive(reply, 0); n > 0; n = modem.Receive(reply, 0)) Heard(n, now);
        if (!connected)
        {
            if (modem.Connected())
            {
                connected = true;
                connectedAt = now;
                Log("connected after " + (now - startedAt).ToString("F1") + " s");
            }
            else if (now - startedAt > timeout) Finish("never connected");
            return;
        }
        if (seq < count && now - connectedAt >= seq + 1)
        {
            seq++;
            Echo(seq);
            sentAt[seq] = now;
        }
        if (seq >= count && !dnsSent && now - sentAt[count] > 3f)
        {
            dnsSent = true;
            dnsAt = now;
            Dns();
        }
        if (dnsSent && (dnsDone || now - dnsAt > 10f)) Finish(dnsDone ? "" : "no DNS answer");
    }

    private void Finish(string why)
    {
        done = true;
        lost = seq - replies;
        Log("pings " + replies + "/" + seq + " rtt mean=" + (replies > 0 ? (rttSum / replies * 1000f).ToString("F0") : "-") +
            " max=" + (rttMax * 1000f).ToString("F0") + " ms " + why);
        Log("probe done");
    }

    private void Heard(int n, float now)
    {
        int proto = reply[9], hl = (reply[0] & 15) * 4;
        if (proto == 1 && reply[hl] == 0)
        {
            int s = reply[hl + 6] << 8 | reply[hl + 7];
            if (s >= 1 && s <= seq && sentAt[s] > 0)
            {
                float rtt = now - sentAt[s];
                sentAt[s] = -1;
                replies++;
                rttSum += rtt;
                rttMax = Mathf.Max(rttMax, rtt);
                Log("ping seq=" + s + " " + (rtt * 1000f).ToString("F0") + " ms");
            }
            return;
        }
        if (proto == 17 && (reply[hl + 2] << 8 | reply[hl + 3]) == 5353 && n >= 4)
        {
            dnsDone = true;
            Log("resolve " + resolve + " = " + reply[n - 4] + "." + reply[n - 3] + "." + reply[n - 2] + "." + reply[n - 1] +
                " in " + ((now - dnsAt) * 1000f).ToString("F0") + " ms");
            return;
        }
        Log("heard " + n + " bytes, protocol " + proto);
    }

    private void Echo(int s)
    {
        int length = 20 + 8 + 32;
        Header(length, 1, target, s);
        packet[20] = 8; packet[21] = 0; packet[22] = 0; packet[23] = 0;
        packet[24] = 0x42; packet[25] = 0x42;
        packet[26] = (byte)(s >> 8); packet[27] = (byte)(s & 255);
        for (int i = 28; i < length; i++) packet[i] = (byte)i;
        int c = Checksum(20, length, 0);
        packet[22] = (byte)(c >> 8); packet[23] = (byte)(c & 255);
        if (!modem.Send(packet, 0, length)) Log("ping seq=" + s + " not sent: no room");
    }

    // A query for an A record, to the gateway's DNS from port 5353.
    private void Dns()
    {
        int at = 28;
        byte[] head = { 0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0 };
        for (int i = 0; i < head.Length; i++) packet[at++] = head[i];
        string[] parts = resolve.Split('.');
        for (int p = 0; p < parts.Length; p++)
        {
            packet[at++] = (byte)parts[p].Length;
            for (int i = 0; i < parts[p].Length; i++) packet[at++] = (byte)parts[p][i];
        }
        packet[at++] = 0; packet[at++] = 0; packet[at++] = 1; packet[at++] = 0; packet[at++] = 1;
        int length = at;
        Header(length, 17, Gateway, 1);
        int u = length - 20;
        packet[20] = 5353 >> 8; packet[21] = 5353 & 255; packet[22] = 0; packet[23] = 53;
        packet[24] = (byte)(u >> 8); packet[25] = (byte)(u & 255); packet[26] = 0; packet[27] = 0;
        // The pseudo-header: addresses, protocol, UDP length.
        int pseudo = Sum(12, 20) + 17 + u;
        int c = Checksum(20, length, pseudo);
        if (c == 0) c = 0xffff;
        packet[26] = (byte)(c >> 8); packet[27] = (byte)(c & 255);
        Log("resolve " + resolve + " sent");
        modem.Send(packet, 0, length);
    }

    private void Header(int length, int proto, int dst, int id)
    {
        int src = modem.address;
        packet[0] = 0x45; packet[1] = 0;
        packet[2] = (byte)(length >> 8); packet[3] = (byte)(length & 255);
        packet[4] = (byte)(id >> 8); packet[5] = (byte)(id & 255);
        packet[6] = 0x40; packet[7] = 0; packet[8] = 64; packet[9] = (byte)proto;
        packet[10] = 0; packet[11] = 0;
        packet[12] = (byte)((src >> 24) & 255); packet[13] = (byte)((src >> 16) & 255); packet[14] = (byte)((src >> 8) & 255); packet[15] = (byte)(src & 255);
        packet[16] = (byte)((dst >> 24) & 255); packet[17] = (byte)((dst >> 16) & 255); packet[18] = (byte)((dst >> 8) & 255); packet[19] = (byte)(dst & 255);
        int c = Checksum(0, 20, 0);
        packet[10] = (byte)(c >> 8); packet[11] = (byte)(c & 255);
    }

    private int Sum(int start, int end)
    {
        int x = 0;
        for (int i = start; i < end; i += 2) x += packet[i] << 8 | (i + 1 < end ? packet[i + 1] : 0);
        return x;
    }

    private int Checksum(int start, int end, int initial)
    {
        int x = initial + Sum(start, end);
        while ((x >> 16) != 0) x = (x & 0xffff) + (x >> 16);
        return ~x & 0xffff;
    }
}
