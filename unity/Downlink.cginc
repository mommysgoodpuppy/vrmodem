#ifndef VRMODEM_DOWNLINK_INCLUDED
#define VRMODEM_DOWNLINK_INCLUDED
// Matches server/downlink.ts. The caller provides _MainTex, its dimensions,
// and integer layout properties. Texture coordinates use Unity's bottom origin.
Texture2D<float4> _MainTex;
float4 _MainTex_TexelSize;
int _Block, _Levels, _Seed;

uint DownlinkHash(uint x)
{
    x = (x ^ (x >> 16)) * 0x7feb352du;
    x = (x ^ (x >> 15)) * 0x846ca68bu;
    return x ^ (x >> 16);
}
uint DownlinkExpected(uint frame, uint index)
{
    return DownlinkHash(DownlinkHash(frame ^ ((uint)_Seed * 0x9e3779b9u)) + index) % (uint)_Levels;
}

// Explicit centre 2x2 averaging matches decode() and is independent of the
// texture's filter mode. All positions are in source pixels, from its top left.
float DownlinkAt(float2 pixel, bool flipped)
{
    int2 p = (int2)floor(pixel - 0.5);
    int h = (int)_MainTex_TexelSize.w;
    int y0 = flipped ? p.y : h - 1 - p.y;
    int y1 = flipped ? p.y + 1 : h - 2 - p.y;
    return (_MainTex.Load(int3(p.x, y0, 0)).r + _MainTex.Load(int3(p.x + 1, y0, 0)).r +
            _MainTex.Load(int3(p.x, y1, 0)).r + _MainTex.Load(int3(p.x + 1, y1, 0)).r) * 0.25;
}
float DownlinkCell(uint cell, bool flipped)
{
    return DownlinkAt(float2(cell * 16 + 8, 8), flipped);
}

// Payload can coincidentally contain the same white/black pair as sync.
// Break that tie with the known calibration endpoints and unused black cells.
float DownlinkHeaderResidual(bool flipped)
{
    float black = DownlinkCell(1, flipped);
    float residual = abs(DownlinkCell(2, flipped) - black) +
                     abs(DownlinkCell(1 + (uint)_Levels, flipped) - DownlinkCell(0, flipped));
    [loop] for (uint c = 2 + (uint)_Levels; c < 10; c++)
        residual += abs(DownlinkCell(c, flipped) - black);
    [loop] for (uint c = 34; c < (uint)_MainTex_TexelSize.z / 16; c++)
        residual += abs(DownlinkCell(c, flipped) - black);
    return residual;
}

struct DownlinkHeader
{
    uint frame;
    bool valid;
    bool flipped;
};
DownlinkHeader DownlinkReadHeader()
{
    DownlinkHeader o;
    o.frame = 0;
    o.valid = false;
    o.flipped = false;
    // Header ends at pixel 544. Only 2/4/8 levels fit before frame cell 10.
    if (_MainTex_TexelSize.z < 544 || _MainTex_TexelSize.w < 16 + _Block ||
        _Block < 2 || (_Block & 1) != 0 || (_Levels != 2 && _Levels != 4 && _Levels != 8)) return o;
    float upright = DownlinkCell(0, false) - DownlinkCell(1, false);
    float inverted = DownlinkCell(0, true) - DownlinkCell(1, true);
    o.flipped = inverted > upright;
    if (upright >= 219.0 / 510.0 && inverted >= 219.0 / 510.0)
        o.flipped = DownlinkHeaderResidual(true) < DownlinkHeaderResidual(false);
    o.valid = max(upright, inverted) >= 219.0 / 510.0;
    if (!o.valid) return o;
    float mid = (DownlinkCell(0, o.flipped) + DownlinkCell(1, o.flipped)) * 0.5;
    [unroll] for (uint b = 0; b < 24; b++)
        o.frame = (o.frame << 1) | (DownlinkCell(10 + b, o.flipped) > mid ? 1u : 0u);
    return o;
}
uint DownlinkSymbol(uint2 block, bool flipped)
{
    float value = DownlinkAt(float2(block.x * _Block + _Block * 0.5,
                                   16 + block.y * _Block + _Block * 0.5), flipped);
    uint best = 0;
    float distance = abs(value - DownlinkCell(2, flipped));
    [loop] for (uint level = 1; level < (uint)_Levels; level++)
    {
        float d = abs(value - DownlinkCell(2 + level, flipped));
        // UNORM loads and averaging can move an exact tie by a float ULP.
        // This tolerance is far below the source's quarter-byte resolution.
        if (d < distance - 1e-7) { best = level; distance = d; }
    }
    return best;
}
#endif
