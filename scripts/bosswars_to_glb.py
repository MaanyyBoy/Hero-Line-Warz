"""
Boss-wars FBX → GLB konverterare. Decision 048.

Samma pattern som mixamo_bosses_to_glb.py — bara T-pose, ingen embedded anim,
texturer decimeras till 1024 px. Output namnges per tier (bosswars_1..5)
enligt user-numreringen i FBX-filnamnen.

Användning (PowerShell):
  & "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" `
      --background --python "C:\\Users\\emanu\\Spel\\src\\scripts\\bosswars_to_glb.py"

Output: src/assets/enemies/Boss wars/bosswars_{1..5}.glb
"""

import bpy, os, sys

RAW_DIR = r'C:\Users\emanu\Spel\src\assets\enemies\Boss wars'
OUT_DIR = r'C:\Users\emanu\Spel\src\assets\enemies\Boss wars'

# Numreringen 1..5 är user-vald boss-wars-tier-ordning.
BOSSES = [
    ('Goblin Archer boss wars 1.fbx',   'bosswars_1'),
    ('Warlock female boss wars 2.fbx',  'bosswars_2'),
    ('No face alien boss wars 3.fbx',   'bosswars_3'),
    ('Big alien boss wars 4.fbx',       'bosswars_4'),
    ('Alien soldier boss wars 5.fbx',   'bosswars_5'),
]

MAX_TEXTURE_SIZE = 1024


def log(msg):
    print(f'[bosswars→glb] {msg}', flush=True)


def reset_scene():
    bpy.ops.wm.read_homefile(use_empty=True)
    for collection in [bpy.data.actions, bpy.data.objects, bpy.data.meshes,
                       bpy.data.armatures, bpy.data.materials, bpy.data.images]:
        for item in list(collection):
            try:
                collection.remove(item)
            except Exception:
                pass


def find_armature():
    for obj in bpy.data.objects:
        if obj.type == 'ARMATURE':
            return obj
    return None


def decimate_textures(max_size):
    shrunk = 0
    for img in bpy.data.images:
        if img.size[0] <= max_size and img.size[1] <= max_size:
            continue
        if img.size[0] > img.size[1]:
            scale = max_size / img.size[0]
        else:
            scale = max_size / img.size[1]
        new_w = max(1, int(img.size[0] * scale))
        new_h = max(1, int(img.size[1] * scale))
        try:
            img.scale(new_w, new_h)
            log(f'    texture "{img.name}" → {new_w}x{new_h}')
            shrunk += 1
        except Exception as e:
            log(f'    WARN scale fail "{img.name}": {e}')
    return shrunk


def convert(fbx_name, out_name):
    log(f'=== {out_name} ===')
    src_path = os.path.join(RAW_DIR, fbx_name)
    if not os.path.exists(src_path):
        log(f'SKIP: {src_path} saknas')
        return False

    reset_scene()
    try:
        bpy.ops.import_scene.fbx(filepath=src_path)
    except Exception as e:
        log(f'FAIL import: {e}')
        return False

    arm = find_armature()
    if not arm:
        log('FAIL: ingen armature')
        return False

    if arm.animation_data and arm.animation_data.action:
        try:
            bpy.data.actions.remove(arm.animation_data.action)
        except Exception:
            pass
    for act in list(bpy.data.actions):
        try:
            bpy.data.actions.remove(act)
        except Exception:
            pass

    shrunk = decimate_textures(MAX_TEXTURE_SIZE)
    if shrunk:
        log(f'  decimated {shrunk} textures → max {MAX_TEXTURE_SIZE}px')

    out_path = os.path.join(OUT_DIR, f'{out_name}.glb')
    try:
        bpy.ops.export_scene.gltf(
            filepath=out_path,
            export_format='GLB',
            export_animations=False,
            export_apply=False,
            use_selection=False,
            export_image_format='AUTO',
            export_image_quality=85,
        )
        size_mb = os.path.getsize(out_path) / (1024 * 1024)
        log(f'WROTE: {out_path} ({size_mb:.1f} MB)')
        return True
    except Exception as e:
        log(f'FAIL export: {e}')
        return False


def main():
    if not os.path.isdir(RAW_DIR):
        log(f'FATAL: RAW_DIR saknas: {RAW_DIR}')
        sys.exit(1)
    ok = 0; fail = 0
    for fbx, out_name in BOSSES:
        if convert(fbx, out_name):
            ok += 1
        else:
            fail += 1
    log('=' * 40)
    log(f'KLART: {ok} OK, {fail} fail. Output i {OUT_DIR}')


if __name__ == '__main__':
    main()
