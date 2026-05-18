"""
Mixamo boss-FBX → GLB konverterare för wave-bossarna.

Skiljer sig från mixamo_to_glb.py på två sätt:
1. INGA animationer importeras — bossarna delar pool med hjältarna runtime
   (shared Mixamo-anim-pool i main.js). Vi behåller bara T-pose-skelett + mesh.
2. Textur-decimering: bossar (särskilt Alien) kan ha 4K-texturer på 100+ MB.
   Vi sänker alla texturer > 1024 px till 1024 px så GLB-filerna håller sig
   mobile-vänliga (mål: < 20 MB per boss).

Användning (från PowerShell):
  & "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" `
      --background --python "C:\\Users\\emanu\\Spel\\src\\scripts\\mixamo_bosses_to_glb.py"

Output: src/assets/enemies/mixamo_bosses/{parasite,gun_zombie,alien,elk_head,undead_assassin}.glb
"""

import bpy
import os
import sys

# ============================================================
# KONFIG
# ============================================================

RAW_DIR = r'C:\Users\emanu\Spel\src\assets\enemies\mixamo_bosses'
OUT_DIR = r'C:\Users\emanu\Spel\src\assets\enemies\mixamo_bosses'

# FBX-filnamn (matchar user-upload) → output GLB-namn (matchar BOSS_GLTF_MAP)
BOSSES = [
    ('Parasite boss 1.fbx',         'parasite'),         # Wave 10 - Captain
    ('Gun zombie boss 2.fbx',       'gun_zombie'),       # Wave 20
    ('Alien boss 3.fbx',            'alien'),            # Wave 30
    ('Elk head boss 4.fbx',         'elk_head'),         # Wave 40
    ('Undead assasin boss 5.fbx',   'undead_assassin'),  # Wave 50 - Drakkonungen-replacement
]

# Max textur-storlek i pixlar. 4K-texturer skalas ned till denna i Blender
# innan GLB-export → 16× mindre textur-payload på 4K → 1024.
MAX_TEXTURE_SIZE = 1024


# ============================================================
# HELPERS
# ============================================================

def log(msg):
    print(f'[boss→glb] {msg}', flush=True)


def reset_scene():
    """Töm Blender helt så vi börjar varje boss med en ren scen."""
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
    """Skala ned alla texturer som är > max_size px till max_size.

    Mixamo-bossarna kan ha 4K diffuse + normal-maps; för web-spel räcker 1K
    gott. Blender bilden ändras in-place innan GLB-export → komprimerad
    textur i output.
    """
    shrunk = 0
    for img in bpy.data.images:
        if img.size[0] <= max_size and img.size[1] <= max_size:
            continue
        # Skala till max kvadrat — behåll aspect men inte över max
        new_w = min(img.size[0], max_size)
        new_h = min(img.size[1], max_size)
        # Behåll aspect ratio
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


def convert_boss(fbx_name, out_name):
    log(f'=== {out_name} ===')
    src_path = os.path.join(RAW_DIR, fbx_name)
    if not os.path.exists(src_path):
        log(f'SKIP: {src_path} saknas')
        return False

    reset_scene()

    # 1. Importera bossen (mesh + armature + T-pose)
    try:
        bpy.ops.import_scene.fbx(filepath=src_path)
    except Exception as e:
        log(f'FAIL import: {e}')
        return False

    arm = find_armature()
    if not arm:
        log('FAIL: ingen armature i FBX')
        return False

    # T-pose-actionen tas bort — vi vill inte ha någon embedded animation,
    # bossen lånar Idle/Walk/Attack/Death från shared Mixamo-pool runtime.
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

    # 2. Textur-decimering — kritiskt för stora bossar (Alien 122 MB)
    shrunk = decimate_textures(MAX_TEXTURE_SIZE)
    if shrunk:
        log(f'  decimated {shrunk} textures → max {MAX_TEXTURE_SIZE}px')

    # 3. Exportera GLB med JPEG-textur-format (mindre än PNG för diffuse).
    # Normal-maps måste vara PNG (förlustlös) men diffuse + roughness kan
    # vara JPEG. Blender väljer automatiskt baserat på material.
    out_path = os.path.join(OUT_DIR, f'{out_name}.glb')
    try:
        bpy.ops.export_scene.gltf(
            filepath=out_path,
            export_format='GLB',
            export_animations=False,   # ← BOSSAR HAR INGA EMBEDDED ANIMS
            export_apply=False,
            use_selection=False,
            export_image_format='AUTO',  # JPEG för diffuse, PNG för normal
            export_image_quality=85,     # JPEG-kvalitet (default 75 → 85 lite snyggare)
        )
        size_mb = os.path.getsize(out_path) / (1024 * 1024)
        log(f'WROTE: {out_path} ({size_mb:.1f} MB)')
        return True
    except Exception as e:
        log(f'FAIL export: {e}')
        return False


# ============================================================
# MAIN
# ============================================================

def main():
    if not os.path.isdir(RAW_DIR):
        log(f'FATAL: RAW_DIR saknas: {RAW_DIR}')
        sys.exit(1)

    ok = 0
    fail = 0
    for fbx, out_name in BOSSES:
        if convert_boss(fbx, out_name):
            ok += 1
        else:
            fail += 1

    log('=' * 40)
    log(f'KLART: {ok} OK, {fail} fail. Output i {OUT_DIR}')


if __name__ == '__main__':
    main()
