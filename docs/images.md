# Image input

An application can supply a string or an ordered, nonempty array of text and image blocks:

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

`InputContent`, `InputBlock`, `ImageBlock` and `IMAGE_INPUT_LIMITS` are public exports. Images require canonical base64 and a matching PNG, JPEG or WebP signature. Small Hour checks the signature and encoding, not the complete image codec or dimensions. Applications select and normalize images, authorize disclosure and supply the bytes. The runtime does not fetch URLs, open files, resize images or omit excess content.

## Validation and provider calls

The frozen `IMAGE_INPUT_LIMITS` applies across explicit input and selected memory:

| Limit | Maximum |
| --- | --- |
| Image count | 20 |
| Decoded bytes per image | 3 MiB |
| Combined decoded bytes | 12 MiB |

These conservative bounds keep base64 image content around 16 MiB and avoid provider thresholds for larger image batches. Instructions, text, tool schemas and provider-specific limits still apply. Image bytes do not determine billed tokens; applications must budget for the selected model's image processing. Choose fewer or smaller images, or explicitly split work, when limits are exceeded.

Malformed input raises `invalid_input`; count or byte overflow raises `image_input_limit`. Explicit input is copied and frozen before context loading. Images require `capabilities.images: true`, otherwise `images_unsupported` is raised. Selected memory is copied and the combined image limits are checked before spending admission. These failures start no model call. Direct adapter calls enforce the same image guards before HTTP.

Anthropic Messages and OpenAI Responses preserve image bytes and text order, including across tool exchanges. The Chat Completions compatibility adapter does not support images. Applications must select a vision-capable model. See [Anthropic vision](https://platform.claude.com/docs/en/build-with-claude/vision) and [OpenAI images](https://developers.openai.com/api/docs/guides/images-vision) for model restrictions and pricing behavior.

## Persistence and recovery

The core retains no images between turns. Opt-in model steps store explicit input, including exact image bytes and order, in the existing `turn_json` record. Incoming input is validated before insertion and persisted input is validated on inspection and replay. A different valid image contract raises `contract_conflict`; malformed stored input raises `invalid_checkpoint`. Completed replay makes no model call. Incomplete work still needs application-authorized recovery.

Reports and spending records do not automatically copy image content. Retrieved memory images are not automatically saved or fingerprinted: bind their immutable identity to the operation input or workflow revision. Applications own storage access, retention and disclosure. Older readers reject array-input checkpoints; retain compatible handlers or stop affected execution during rollback.
