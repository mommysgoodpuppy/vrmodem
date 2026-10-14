// The modem's downlink frame as bytes (MODEM.md): the video's blocks, four
// levels each, packed four blocks a byte, for Modem.cs to read back.
//
// Blit the video texture into a linear ARGB32 target of 1 + bytes / 4 texels
// by 1. Texel 0 is the frame number (r, g, b: bits 0-7, 8-15, 16-23) and a = 255
// when the header is valid; texel 1 + t holds bytes 4t .. 4t + 3 in r, g, b, a.
// Byte k is blocks 4k .. 4k + 3, the first in its top two bits, blocks
// row-major from the top left.
Shader "vrmodem/ModemPack"
{
    Properties
    {
        _MainTex ("Video texture", 2D) = "black" {}
        _Block ("Block size (even pixels)", Int) = 8
        _Levels ("Gray levels", Int) = 4
        _Seed ("Unused", Int) = 0
    }
    SubShader
    {
        Cull Off ZWrite Off ZTest Always
        Pass
        {
            Name "Pack"
            HLSLPROGRAM
            #pragma target 5.0
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"
            #include "Downlink.cginc"

            struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
            v2f vert(appdata_img v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = v.texcoord;
                return o;
            }

            uint Byte(uint k, uint cols, uint count, bool flipped)
            {
                uint b = 0;
                [unroll] for (uint j = 0; j < 4; j++)
                {
                    uint i = k * 4 + j;
                    uint s = i < count ? DownlinkSymbol(uint2(i % cols, i / cols), flipped) : 0;
                    b = (b << 2) | (s & 3);
                }
                return b;
            }

            float4 frag(v2f i) : SV_Target
            {
                DownlinkHeader h = DownlinkReadHeader();
                uint x = (uint)i.pos.x; // the target's texel: SV_Position is its centre
                if (!h.valid) return 0;
                if (x == 0)
                    return float4(h.frame & 255, (h.frame >> 8) & 255, (h.frame >> 16) & 255, 255) / 255.0;
                uint cols = (uint)_MainTex_TexelSize.z / (uint)_Block;
                uint rows = (uint)max(_MainTex_TexelSize.w - 16, 0) / (uint)_Block;
                uint count = cols * rows, k = (x - 1) * 4;
                return float4(Byte(k, cols, count, h.flipped), Byte(k + 1, cols, count, h.flipped),
                              Byte(k + 2, cols, count, h.flipped), Byte(k + 3, cols, count, h.flipped)) / 255.0;
            }
            ENDHLSL
        }
    }
}
