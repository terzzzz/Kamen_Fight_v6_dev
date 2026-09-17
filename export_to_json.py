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

# 4. Map PyTorch tensors into JSON layers
layers = data["net"]["layers"]
updated_count = 0

if isinstance(layers, list):
    # Sequential mapping for array-based layer structure
    tensors = list(state_dict.values())
    for i in range(min(len(layers), len(tensors))):
        weights_list = tensors[i].tolist()
        if isinstance(layers[i], dict) and "weights" in layers[i]:
            layers[i]["weights"] = weights_list
        else:
            layers[i] = weights_list
        updated_count += 1
elif isinstance(layers, dict):
    # Dictionary mapping if layers are keyed
    for pt_key, tensor in state_dict.items():
        weights_list = tensor.tolist()
        stripped_key = pt_key.replace("net.", "")
        if pt_key in layers:
            layers[pt_key] = weights_list
            updated_count += 1
        elif stripped_key in layers:
            layers[stripped_key] = weights_list
            updated_count += 1

# 5. Save updated JSON
with open("data/wt_ichigo_nn.json", "w") as f:
    json.dump(data, f, indent=2)

print(f"SUCCESS: Updated games to 7800 and overwrote {updated_count} weight layers!")