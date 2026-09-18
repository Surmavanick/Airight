"""Verify the exact direct detector dependencies used by the Aright worker."""

from __future__ import annotations

import importlib.metadata as metadata


EXPECTED = {
    "pip": "25.3",
    "torch": "2.9.1",
    "torchvision": "0.24.1",
    "transformers": "4.46.3",
    "timm": "1.0.24",
    "safetensors": "0.7.0",
    "huggingface-hub": "0.36.2",
    "onnxruntime": "1.30.0",
    "Pillow": "12.1.0",
    "numpy": "2.2.6",
    "pypdf": "6.19.0",
    "python-docx": "1.2.0",
}


def main() -> None:
    import torch

    problems: list[str] = []
    for package, wanted in EXPECTED.items():
        try:
            actual = metadata.version(package).split("+", 1)[0]
        except metadata.PackageNotFoundError:
            problems.append(f"{package}: missing (expected {wanted})")
            continue
        if actual != wanted:
            problems.append(f"{package}: {actual} (expected {wanted})")
    if torch.version.cuda is not None:
        problems.append(f"torch: CUDA build detected ({torch.version.cuda}); expected CPU build")
    if problems:
        print("Pinned dependency mismatch: " + "; ".join(problems))
        raise SystemExit(1)
    print("Pinned dependency versions match exactly.")


if __name__ == "__main__":
    main()
