import base64
import os

html_path = r'c:\家計簿\travel_guide.html'
out_path = r'c:\家計簿\travel_guide.html'

with open(html_path, 'r', encoding='utf-8-sig') as f:
    content = f.read()

images = [
    'header_shikoku.png',
    'shimonada.png',
    'chichibugahama.png',
    'dogo_onsen.png',
    'shimanami.png',
    'shodoshima.png',
    'yadon_park.png',
    'udon_baka.png',
    'sakubee_somen.png'
]

for img_name in images:
    full_img_path = os.path.join(r'c:\家計簿', img_name)
    if os.path.exists(full_img_path):
        with open(full_img_path, 'rb') as img_f:
            b64_str = base64.b64encode(img_f.read()).decode('utf-8')
            data_url = f'data:image/png;base64,{b64_str}'
            content = content.replace(f"url('{img_name}')", f"url('{data_url}')")
            content = content.replace(f'src="{img_name}"', f'src="{data_url}"')

with open(out_path, 'w', encoding='utf-8-sig') as f:
    f.write(content)

print("All images embedded directly into single HTML file successfully!")
