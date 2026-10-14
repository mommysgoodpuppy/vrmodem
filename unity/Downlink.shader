Shader "vrmodem/Downlink"
{
    Properties
    {
        _MainTex ("Video texture", 2D) = "black" {}
        _Block ("Block size (even pixels)", Int) = 16
        _Levels ("Gray levels (2, 4 or 8)", Int) = 2
        _Seed ("Test pattern seed", Int) = 1
    }
    SubShader
    {
        Cull Off ZWrite Off ZTest Always
        Pass
        {
            Name "Decode"
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
            // Blit to a linear ARGBFloat target: cols x (rows + 1).
            // Top-left texel: (frame, valid, vertically flipped, block count).
            // Rest of top row: zero. Data rows: (symbol, expected, error, valid).
            // Invalid input produces zero data and frame=-1 in the header.
            float4 frag(v2f i) : SV_Target
            {
                uint cols = (uint)_MainTex_TexelSize.z / (uint)max(_Block, 2);
                uint rows = (uint)max(_MainTex_TexelSize.w - 16, 0) / (uint)max(_Block, 2);
                uint2 pos = (uint2)floor(float2(i.uv.x, 1 - i.uv.y) * float2(cols, rows + 1));
                if (pos.x >= cols || pos.y > rows) return 0;
                DownlinkHeader header = DownlinkReadHeader();
                if (pos.y == 0)
                {
                    if (pos.x != 0) return 0;
                    return float4(header.valid ? (float)header.frame : -1.0,
                                  header.valid ? 1 : 0, header.flipped ? 1 : 0, cols * rows);
                }
                if (!header.valid) return 0;
                uint2 block = uint2(pos.x, pos.y - 1);
                uint decoded = DownlinkSymbol(block, header.flipped);
                uint expected = DownlinkExpected(header.frame, block.y * cols + block.x);
                return float4(decoded, expected, decoded != expected ? 1 : 0, 1);
            }
            ENDHLSL
        }
    }
    Fallback Off
}
