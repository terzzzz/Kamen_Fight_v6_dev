# export_weights.py
import json
import torch
from train_pure import SoulNN

def export_to_js(model_path="soul_ichigo.pth", template_path="data/ichigo_nn.json", output_path="data/ichigo_nn.json"):
    model = SoulNN()
    model.load_state_dict(torch.load(model_path))
    model.eval()

    with open(template_path, 'r') as f:
        data = json.load(f)

    with torch.no_grad():
        layers = [
            {
                "w": model.net[0].weight.cpu().numpy().flatten().tolist(),
                "b": model.net[0].bias.cpu().numpy().tolist()
            },
            {
                "w": model.net[2].weight.cpu().numpy().flatten().tolist(),
                "b": model.net[2].bias.cpu().numpy().tolist()
            },
            {
                "w": model.net[4].weight.cpu().numpy().flatten().tolist(),
                "b": model.net[4].bias.cpu().numpy().tolist()
            }
        ]

    data["net"]["layers"] = layers
    
    with open(output_path, 'w') as f:
        json.dump(data, f)
    print(f"Successfully exported PyTorch weights to {output_path}")

if __name__ == "__main__":
    export_to_js()
