# ComfyUI Panorama Stickers

[![LoRA: Hugging Face](https://img.shields.io/badge/LoRA-Hugging%20Face-f0b429.svg)](https://huggingface.co/nomadoor/flux-2-klein-4B-360-erp-outpaint-lora)
[![Guide: Coming Soon](https://img.shields.io/badge/Guide-Coming%20Soon-6b7280.svg)](#links)

ComfyUI Panorama Stickers is a small node set for laying out image stickers on a 360 equirectangular panorama, previewing the panorama interactively, and extracting framed cutouts from it.

It is designed for my FLUX.2 Klein panorama workflow and can be used with both 4B and 9B variants.

This workflow was built to support my FLUX.2 Klein 4B 360 ERP outpaint LoRA:

- LoRA: [nomadoor/flux-2-klein-4B-360-erp-outpaint-lora](https://huggingface.co/nomadoor/flux-2-klein-4B-360-erp-outpaint-lora)

Usage details are documented on my site.

## Installation

- Install via ComfyUI Manager.

## Demo

- Demo video: coming soon

## Nodes

- `Panorama Stickers`: Place, scale, and rotate sticker images onto an ERP canvas and output a composited conditioning panorama.
- `Panorama Cutout`: Extract a framed perspective view from an ERP image using a saved camera/frame state.
- `Panorama Preview`: Show an interactive panorama preview inside ComfyUI without duplicating the default image preview.

## Workflow

- Workflow example: coming soon

## License

MIT.

Note: add a `LICENSE` file to the repo root so the license is explicit in-distribution.
