import json
import torch

# 1. Load PyTorch checkpoint
checkpoint = torch.load("soul_ichigo.pth", map_location="cpu")
state_dict = checkpoint.get("state_dict", checkpoint) if isinstance(checkpoint, dict) else checkpoint

# 2. Load JSON template
with open("data/wt_ichigo_nn.json", "r") as f:
    data = json.load(f)

# 3. Update game count
data["games"] = 7800

# 4. Update weights & biases in-place inside existing layer objects
layers = data["net"]["layers"]
py_indices = [0, 2, 4]

for json_idx, py_idx in enumerate(py_indices):
    w_key = f"net.{py_idx}.weight"
    b_key = f"net.{py_idx}.bias"

    if json_idx < len(layers) and isinstance(layers[json_idx], dict):
        layer = layers[json_idx]
        
        if w_key in state_dict:
            w_target = "weights" if "weights" in layer else ("w" if "w" in layer else None)
            if w_target:
                layer[w_target] = state_dict[w_key].tolist()

        if b_key in state_dict:
            b_target = "bias" if "bias" in layer else ("b" if "b" in layer else None)
            if b_target:
                layer[b_target] = state_dict[b_key].tolist()

# 5. Save as compact JSON (no indent)
with open("data/wt_ichigo_nn.json", "w") as f:
    json.dump(data, f)

print("SUCCESS: Overwrote weights in-place with valid schema!")

