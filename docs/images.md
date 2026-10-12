# Give the model an image

Pass an ordered list of text and image blocks to `turn()`. Your app supplies the image bytes and chooses what the model may see.

```ts
await runtime.turn({
  agentId,
  input: [
    { type: "text", text: "Describe the supplied image." },
    { type: "image", mediaType: "image/png", data: selectedBase64 },
  ],
  allowedTools: [],
});
```

Anthropic and OpenAI Responses support images with a vision-capable model. The OpenAI-compatible Chat Completions adapter does not.

## Prepare and limit the input

Images must be PNG, JPEG, or WebP, with canonical base64 matching the file signature. Small Hour checks encoding and signature; it does not fully decode the image or check dimensions.

Your app loads files, authorizes disclosure, and resizes or converts images when needed. Small Hour fetches no URLs and opens no image files.

The public `IMAGE_INPUT_LIMITS` applies to explicit input and selected memory together:

| Limit | Maximum |
| --- | --- |
| Number of images | 20 |
| Decoded bytes per image | 3 MiB |
| Combined decoded bytes | 12 MiB |

Oversized requests fail. Your app can select fewer images, shrink them, or explicitly split the work. Images are never silently dropped. Provider/model limits may be stricter; image bytes are not a token or cost estimate.

## What happens before the call?

Small Hour copies and freezes explicit input before loading context, then checks the combined input and memory before spending admission.

| Error | Meaning |
| --- | --- |
| `invalid_input` | Malformed image or input. |
| `image_input_limit` | Too many images or bytes. |
| `images_unsupported` | The adapter does not declare image support. |

These errors make no model call. Direct adapter calls perform the same image checks before HTTP. Custom providers must declare `capabilities.images: true`.

Text/image order and original image bytes survive the tool exchange. Callbacks receive `InputContent`; narrow `typeof context.input === "string"` before using string methods. `InputBlock` and `ImageBlock` are also public types.

## What is saved?

The core keeps no images between turns. Optional [model steps](model-steps.md) save explicit image input exactly, including order. Changed valid input conflicts with the saved contract; malformed saved input raises `invalid_checkpoint`.

Retrieved memory images are not automatically saved or identified for replay. Bind immutable image references to your operation input or workflow version when their identity matters.

Reports and spending records do not automatically copy image content. Optional [trace capture](tracing.md) can include it. Your app owns storage access and retention. Older checkpoint readers may reject image input; keep compatible handlers during [upgrades](releases.md).
