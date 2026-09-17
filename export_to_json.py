import torch
import json
import os

pth_path = "soul_ichigo.pth"
json_path = "data/wt_ichigo_nn.json"

if not os.path.exists(pth_path):
    print(f"Error: Could not find {pth_path} in the current directory.")
    exit(1)

# 1. Load PyTorch checkpoint
checkpoint = torch.load(pth_path, map_location="cpu")
state_dict = checkpoint.get("state_dict", checkpoint) if isinstance(checkpoint, dict) else checkpoint

# 2. Load current JSON template
with open(json_path, "r") as f:
    data = json.load(f)

# 3. Update training game count
data["games"] = 7800

# 4. Convert PyTorch tensors to JSON lists
if "net" in data and "layers" in data["net"]:
    for layer_name, tensor in state_dict.items():
        if layer_name in data["net"]["layers"]:
            data["net"]["layers"][layer_name] = tensor.tolist()

# 5. Save updated JSON
with open(json_path, "w") as f:
    json.dump(data, f, indent=2)

print("SUCCESS: wt_ichigo_nn.json updated with 7800-game weights!")
