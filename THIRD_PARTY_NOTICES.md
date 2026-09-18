# Detector model notices

Aright records the exact model identifier and revision in every evidence export. Detector output is a screening signal, not proof of authorship, infringement, ownership, or legal protection.

Verbatim upstream license texts are bundled in [`licenses/`](licenses/), including the conflicting AASIST3 source license. Font OFL texts are bundled beside the font files in `assets/fonts/`.

## Hosted AI or Not service

The Vercel deployment sends text, image bytes, sampled video frames, and 16 kHz voice audio to the commercial AI or Not API through server-side functions. The API key stays server-side. Aright uses the documented `v2/text/sync`, `v2/image/sync?only=ai_generated`, and `v1/reports/voice` endpoints and retains the provider request ID, timestamp, returned score/verdict, model scope, and raw provider response in the downloadable evidence record. Video remains frame-level image screening; the full video is not uploaded. Voice screening is not AI-music detection.

AI or Not states that uploaded content is deleted after inference; its [API documentation](https://docs.aiornot.com/llms.txt), [privacy policy](https://www.aiornot.com/privacy-policy), account terms, and billing govern that remote processing. Provider output is a screening signal and is not a bundled/licensed model artifact. The local launcher described below remains a separate self-hosted option.

## Text

- Model: `fakespot-ai/roberta-base-ai-text-detection-v1`
- Revision: `f9cdb14d1f8b105f597d80fa7b56f20c6ea0e9db`
- Checkpoint SHA-256: `adc87ded15a8fbea26dec51a747adfd59ad1e9021073287e7e5e29209564e56c`
- License declared by the model and ApolloDFT repository: Apache-2.0
- Base model: `FacebookAI/roberta-base`; MIT notice bundled as [`licenses/RoBERTa-fairseq-MIT.txt`](licenses/RoBERTa-fairseq-MIT.txt)
- Sources: <https://huggingface.co/fakespot-ai/roberta-base-ai-text-detection-v1> and <https://github.com/fakespot-ai/apollodft>
- Scope: English text, up to 512 model tokens per window. The score is an AI-class model signal, not the percentage of words written by AI.

## Image and sampled video frames

In the local launcher, configuring `AIORNOT_API_KEY` calls the commercial AI or Not v2 image API with only the `ai_generated` report and then runs the self-hosted checkpoint below as a comparison. Scores are never averaged; disagreement becomes inconclusive. The evidence export retains the provider request ID, raw provider verdict, both named scores, generator hints, and the decision policy. Optional C2PA data has appeared in live responses but is not documented in the current v2 image schema, so Aright never relies on its presence or absence. The hosted deployment uses the AI or Not signal without bundling the local checkpoint.

- Model: `OwensLab/commfor-model-384`
- Revision: `6076002bf0d9dd37537f965ee2f06f826c333b61`
- Checkpoint SHA-256: `b89f36275f3bf5e2b040eee36597a8f19db051bff9a473a9cf7b2466284fb387`
- License: MIT
- Sources: <https://huggingface.co/OwensLab/commfor-model-384> and <https://github.com/JeongsooP/Community-Forensics>
- Scope: still-image synthetic-content screening. Video support scores sampled still frames; it does not inspect temporal motion, face swaps, audio, or every frame.

## Synthetic or cloned speech

- Model artifact: `Limitless-8/spectra-aasist3-int8-audio-deepfake`
- Revision: `b56aed04853cb4e5bf825025c54c93d4bc345c61`
- ONNX SHA-256: `444f832d306a2be4f823119f84e698e8821db6a1aab248593d4b05b7a9a48108`
- Artifact/model-card license declaration: Apache-2.0
- Sources: <https://huggingface.co/Limitless-8/spectra-aasist3-int8-audio-deepfake> and <https://huggingface.co/lab260/Spectra-AASIST3>
- Scope: speech anti-spoofing only; not AI music or general audio detection.
- Long clips: Aright scores consecutive 4.04-second windows covering the first 60 seconds. Its maximum score and multi-window verdict policy are application-level extensions that have not been independently calibrated.
- Base-model provenance: the published Spectra model identifies `facebook/wav2vec2-xls-r-300m` (Apache-2.0) in its lineage.

The upstream [AASIST3 source repository](https://github.com/lab260ru/AASIST3) currently declares CC BY-NC-ND 4.0 while the published model artifacts declare Apache-2.0. Aright therefore treats this audio adapter as a research/prototype integration. Obtain a human license/provenance review or replace it with a commercially contracted provider before redistributing it in a commercial product.
