# Downlink decoder

`unity/Downlink.shader` decodes the gray-block test format in
`server/downlink.ts`. `unity/Downlink.cginc` holds the sampling, header decode,
nearest-calibration decision, and unsigned lowbias32 test-pattern hash. It
uses a graphics fragment shader, texture reads, and a float render target;
there are no compute shaders or UAVs.

## Unity / Udon

Create a material using `vrmodem/Downlink`. Set `_Block`, `_Levels`, and `_Seed`
from the selected entry of `media/down/configs.json`. The supported level
counts are 2, 4, and 8; blocks must be even and at least two pixels. A source
must be at least 544 pixels wide to hold the full header. The current test
videos are 1280×720 with blocks of 16, 8, or 4 and levels of 2 or 4.

Blit the video's texture with this material's `Decode` pass (pass 0). For
source dimensions `w × h`, the destination must be:

- width: `floor(w / block)`
- height: `floor((h - 16) / block) + 1`
- format: **ARGBFloat**, linear, without mipmaps

For example, a 1280×720 source with eight-pixel blocks needs a 160×89 target.
Use `VRCGraphics.Blit(videoTexture, decodedTexture, material, 0)` in Udon, or
`Graphics.Blit` in Unity code. The blit binds `_MainTex` and its dimensions.
The source's filtering setting does not matter: the shader explicitly averages
the four centre pixels, as `decode()` does. Bind the complete video texture,
without cropping or UV transforms. Black/not-ready textures produce invalid
metadata rather than frame zero.

The output has a metadata row followed by the payload's block rows, ordered
from the top left:

| Texel | R | G | B | A |
| --- | --- | --- | --- | --- |
| Top-left | 24-bit frame index (or −1 if invalid) | Header valid (0/1) | Source vertically flipped (0/1) | Number of payload blocks |
| Other texels in top row | 0 | 0 | 0 | 0 |
| Payload block | Decoded symbol (0 to levels−1) | Expected test symbol | Symbol mismatch (0/1) | Header valid (0/1) |

Invalid frames produce zero payload texels. The decoder detects vertical
orientation using sync; if both edges resemble sync, it compares calibration
endpoints and unused black header cells. Frame bits are MSB first and use
the white/black midpoint. Payload levels use the nearest *sampled*
calibration value, with ties going to the lower level (a 1e−7 tolerance absorbs float rounding). The expected-symbol
channel checks this experiment's seeded pattern; the decoded-symbol channel
can be used independently for future payloads.

Read back as float RGBA, not bytes or half precision: float32 preserves every
24-bit frame index exactly. Unity `Texture2D.GetPixels()` orders rows from the
bottom, so metadata begins at `(target.height - 1) * target.width`. Sum B
across payload texels to get the symbol error count; check header validity
before accepting any frame.

## ShaderEmu

The same `.shader` can be loaded by ShaderEmu's ShaderLab harness (it supports
`HLSLPROGRAM`). Supply its Unity include directory and this shader's directory
for includes. Bind `_MainTex` through `Material::setTexture` so
`_MainTex_TexelSize` is populated, and set the three integer properties. Render
the `Decode` pass to `DXGI_FORMAT_R32G32B32A32_FLOAT` with the dimensions above.
The harness's blit convention, UV y=1 at the top, matches this shader.

For a shader that consumes the decoded symbols directly, include
`Downlink.cginc` and call `DownlinkReadHeader()`, `DownlinkSymbol(block, flipped)`,
and optionally `DownlinkExpected(frame, index)`. The include declares the
source texture and layout uniforms. Check `header.valid` first. In this API
block coordinates and indices are row-major from the source's top left.
Memory/mailbox integration into the emulated machine is separate from decoding.

## GPU check

```sh
cd server
deno task check-down-shader
```

This generates fixtures with the real TypeScript encoder and reference
`decode()`, then runs `DownlinkShaderCheck.Run` in a batch Unity graphics
context and checks every output block and the reference's error count. It
covers upright/flipped input, 2/4/8 levels, all generated block sizes, 24-bit
frame boundaries, unsigned seed arithmetic, damaged payloads, invalid sync,
ambiguous sync, and partial edge blocks. If `media/down/configs.json` exists,
it also tests the first decoded frame of each generated H.264 video.

Requires a closed Unity project, a working graphics display, and ffmpeg for
existing videos. `--project PATH` and `--unity PATH` override the machine's
defaults. On Linux the runner selects OpenGL; Windows/VRChat's D3D11 compiler
and live video textures still need a client check. The log is
`logs/downlink-shader-check.log`. This check does not launch VRChat or export
a world.
