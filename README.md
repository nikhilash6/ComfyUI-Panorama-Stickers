# ComfyUI Panorama Stickers

[![LoRA 4B](https://img.shields.io/badge/LoRA-4B-f0b429.svg)](https://huggingface.co/nomadoor/flux-2-klein-4B-360-erp-outpaint-lora)
[![LoRA 9B](https://img.shields.io/badge/LoRA-9B-f59e0b.svg)](https://huggingface.co/nomadoor/flux-2-klein-9B-360-erp-outpaint-lora)
[![Live Demo](https://img.shields.io/badge/Spaces-Live%20Demo-orange)](https://huggingface.co/spaces/nomadoor/flux2-klein-4b-erp-outpaint-lora-demo)
[![Guide](https://img.shields.io/badge/Guide-English-3b82f6.svg)](https://comfyui.nomadoor.net/en/notes/panorama-stickers/)

ComfyUI Panorama Stickers is a small node set for laying out image stickers on a 360 equirectangular panorama, previewing the panorama interactively, and extracting framed cutouts from it.

It is designed for my FLUX.2 Klein panorama workflow and can be used with both 4B and 9B variants.

This workflow was built to support my FLUX.2 Klein 4B 360 ERP outpaint LoRA:

- [nomadoor/flux-2-klein-4B-360-erp-outpaint-lora](https://huggingface.co/nomadoor/flux-2-klein-4B-360-erp-outpaint-lora)
- [nomadoor/flux-2-klein-9B-360-erp-outpaint-lora](https://huggingface.co/nomadoor/flux-2-klein-9B-360-erp-outpaint-lora)

Usage details are documented here:

- English: [comfyui.nomadoor.net/en/notes/panorama-stickers/](https://comfyui.nomadoor.net/en/notes/panorama-stickers/)
- 日本語: [comfyui.nomadoor.net/ja/notes/panorama-stickers/](https://comfyui.nomadoor.net/ja/notes/panorama-stickers/)
- 中文: [comfyui.nomadoor.net/zh/notes/panorama-stickers/](https://comfyui.nomadoor.net/zh/notes/panorama-stickers/)

## Installation

- Install via ComfyUI Manager.

## Demo

https://github.com/user-attachments/assets/bf74e953-8ceb-4c7f-afa2-1c805f12c7af

## Nodes

- `Panorama Stickers`: Place, scale, and rotate sticker images onto an ERP canvas and output a composited conditioning panorama.
- `Panorama Cutout`: Extract a framed perspective view from an ERP image using a saved camera/frame state.
- `Panorama Preview`: Show an interactive panorama preview inside ComfyUI without duplicating the default image preview.
- `Panorama Seam Prep`: Shift an ERP seam into the center and generate hard / blurred vertical seam masks for seam-focused inpainting.

## Workflow

- [flux-2-klein-4B-360-erp-outpaint.json](./example_workflows/flux-2-klein-4B-360-erp-outpaint.json)
- [flux-2-klein-9B-360-erp-outpaint.json](./example_workflows/flux-2-klein-9B-360-erp-outpaint.json)

## Changelog

### 1.1.0

- Switched panorama rendering to a WebGL-first pipeline.
- Added support for compositing images produced by `Panorama Cutout` back into the panorama through the `Panorama Stickers` node.

## ToDo

- Enable painting directly inside the modal UI.
- Merge the `Panorama Stickers` node and the `Panorama Cutout` node into a unified workflow.
- Add integration with Hugin.

## License

MIT
