# Model brand logos

SVGs copied unchanged from the user-provided `/Users/liujialin/Downloads/lobe-icons-static-svg/icons` (`@lobehub/icons-static-svg@1.95.0`).

Model families resolve in `src/shared/model-brand.ts`, including provider-qualified IDs and new version suffixes.

| Model family             | Asset                                                                |
| ------------------------ | -------------------------------------------------------------------- |
| Kimi / k3                | kimi-color.svg                                                       |
| Grok                     | grok.svg                                                             |
| DeepSeek                 | deepseek-color.svg                                                   |
| Qwen                     | qwen-color.svg                                                       |
| GLM / ChatGLM            | zai.svg                                                              |
| MiniMax                  | minimax.svg                                                    |
| LongCat                  | longcat-color.svg                                                    |
| MiMo                     | xiaomimimo.svg                                                       |
| Hy / Hunyuan             | hunyuan-color.svg                                                    |
| GPT / OpenAI reasoning   | openai.svg                                                           |
| Muse Spark / Llama       | meta-color.svg                                                       |
| Claude                   | claude-color.svg                                                     |
| Gemini                   | gemini-color.svg                                                     |
| Union Alpha / Omen Alpha | opencode.svg (platform fallback, not a claim about model authorship) |

Checked all 38 IDs in the [OpenCode Go model endpoint](https://opencode.ai/zen/go/v1/models) on 2026-09-17; [official model documentation](https://opencode.ai/docs/go/) identifies the available families. The supplied icon set contains no dedicated Union Alpha or Omen Alpha mark. Unknown families retain a neutral model icon.

Icons retain original colors. Kimi's white mark uses a dark plate in both themes; other marks use a light plate.

OpenAI 和 Codex 共用用户提供的 `/Users/liujialin/Downloads/openai.svg`；资源原样保存，深色主题通过 CSS 反色显示。

MiniMax 使用用户提供的 `/Users/liujialin/Downloads/minimax.svg`，原样保存；账号、模型及手机看板的图标在浅色主题为黑色，深色主题为白色。

Command Code 使用[官方品牌资源页](https://commandcode.ai/brand)提供的 [symbol.svg](https://raw.githubusercontent.com/CommandCodeAI/command-code/refs/heads/main/.github/commandcode/symbols/symbol.svg)，保存为 `commandcode.svg`（2026-09-21）。原样保留官方颜色与比例，用于桌面账号和手机看板，不应用反色滤镜。浅色主题使用官方 [black-symbol-commandcode.svg](https://raw.githubusercontent.com/CommandCodeAI/command-code/refs/heads/main/.github/commandcode/symbols/black-symbol-commandcode.svg)（保存为 `commandcode-light.svg`），深色主题切换为带白色边框的 `commandcode.svg`。
