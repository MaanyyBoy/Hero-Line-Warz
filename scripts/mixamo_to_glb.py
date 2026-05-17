"""
Mixamo FBX → GLB batch-konverterare för Spel-projektet.

Körs i Blender (huvudlös, --background --python). Tar varje hjälte-T-pose-FBX
i mixamo_raw/, importerar alla animations-FBX:er ovanpå armaturen, döper om
clip-namnen till våra konventioner (Idle/Walking/Running/Death/etc.), och
exporterar en färdig .glb per hjälte till mixamo/.

Användning (från PowerShell):
  & "C:\\Program Files\\Blender Foundation\\Blender 4.x\\blender.exe" `
      --background --python "C:\\Users\\emanu\\Spel\\src\\scripts\\mixamo_to_glb.py"

Output: src/assets/heroes/mixamo/{gandulf,legolus,gimlu,aragurn,kostefos}.glb
"""

import bpy
import os
import sys

# ============================================================
# KONFIG
# ============================================================

RAW_DIR = r'C:\Users\emanu\Spel\src\assets\heroes\mixamo_raw'
OUT_DIR = r'C:\Users\emanu\Spel\src\assets\heroes\mixamo'

# Karaktär-FBX → output-namn (lowercase, matchar HEROES-ids i main.js)
HEROES = [
    ('Gandulf.fbx',  'gandulf'),
    ('Legolus.fbx',  'legolus'),
    ('Gimlu.fbx',    'gimlu'),
    ('Aragurn.fbx',  'aragurn'),
    ('Kostefos.fbx', 'kostefos'),
]

# Animation-FBX → target clip-namn (det namn vi pratar om i koden).
# Alla 11 animationer assignas till varje hjälte; i main.js mappas heroId
# till rätt AA/skill-clip per hjälte (t.ex. Magic_Attack för Gandulf,
# Bow_Attack för Legolus, 1H_Slash för Aragurn, etc.).
ANIMATIONS = [
    ('idle.fbx',                          'Idle'),
    ('Walking.fbx',                       'Walking'),
    ('Running.fbx',                       'Running'),
    ('sword slash.fbx',                   '1H_Slash'),
    ('Great Sword Slash.fbx',             '2H_Slash'),
    ('Standing 2H Magic Attack 01.fbx',   'Magic_Attack'),
    ('Standing Aim Recoil.fbx',           'Bow_Attack'),
    ('Spell Casting.fbx',                 'Spellcast'),
    ('Hit Reaction.fbx',                  'Hit_Reaction'),
    ('Standing Dive Forward.fbx',         'Dive'),
    ('Death.fbx',                         'Death'),
]


# ============================================================
# HELPERS
# ============================================================

def log(msg):
    print(f'[mixamo→glb] {msg}', flush=True)


def reset_scene():
    """Töm Blender helt så vi börjar varje hjälte med en ren scen."""
    bpy.ops.wm.read_homefile(use_empty=True)
    # read_homefile lämnar oftast lite kvar — explicit rensning för säkerhet
    for collection in [bpy.data.actions, bpy.data.objects, bpy.data.meshes,
                       bpy.data.armatures, bpy.data.materials, bpy.data.images]:
        for item in list(collection):
            try:
                collection.remove(item)
            except Exception:
                pass


def find_armature():
    """Hitta första armaturen i scenen (Mixamo skapar alltid 'Armature')."""
    for obj in bpy.data.objects:
        if obj.type == 'ARMATURE':
            return obj
    return None


def import_anim_and_rename(anim_path, target_name, hero_armature):
    """Importera animations-FBX och döp om dess action till target_name.

    Mixamo-FBX (Without Skin) skapar en duplicate armature + en action vid
    import. Vi tar action:en, assignar den till hero-armaturen via NLA, och
    tar bort duplikat-armaturen.
    """
    actions_before = set(bpy.data.actions.keys())
    objects_before = set(bpy.data.objects.keys())

    try:
        bpy.ops.import_scene.fbx(filepath=anim_path)
    except Exception as e:
        log(f'  FAIL import: {os.path.basename(anim_path)} → {e}')
        return False

    new_actions = [bpy.data.actions[n] for n in bpy.data.actions.keys() if n not in actions_before]
    new_objects = [bpy.data.objects[n] for n in bpy.data.objects.keys() if n not in objects_before]

    if not new_actions:
        log(f'  WARN: {os.path.basename(anim_path)} skapade ingen action')
        # Ta bort imported skräp ändå
        for obj in new_objects:
            try:
                bpy.data.objects.remove(obj, do_unlink=True)
            except Exception:
                pass
        return False

    # Renamea action (om duplikat-namn finns redan, Blender lägger till .001 — fixa)
    action = new_actions[0]
    if target_name in bpy.data.actions and bpy.data.actions[target_name] != action:
        # Ta bort gammal
        bpy.data.actions.remove(bpy.data.actions[target_name])
    action.name = target_name

    # Skapa NLA-track på hero-armaturen så GLB-exporten inkluderar action:en
    # som en distinkt animation-clip. Utan NLA exporterar Blender bara den
    # aktiva action:en (en clip per export).
    if hero_armature.animation_data is None:
        hero_armature.animation_data_create()
    track = hero_armature.animation_data.nla_tracks.new()
    track.name = target_name
    start_frame = int(action.frame_range[0])
    track.strips.new(target_name, start_frame, action)
    # Säkerställ att NLA-spåret inte mut:as (annars exporteras det inte)
    track.mute = False

    # Rensa duplikat-armatur + mesh från animation-importen
    for obj in new_objects:
        if obj == hero_armature:
            continue
        try:
            bpy.data.objects.remove(obj, do_unlink=True)
        except Exception:
            pass

    log(f'  OK: {target_name}')
    return True


def convert_hero(char_fbx_name, out_name):
    log(f'=== {out_name} ===')
    char_path = os.path.join(RAW_DIR, char_fbx_name)
    if not os.path.exists(char_path):
        log(f'SKIP: {char_path} saknas')
        return False

    reset_scene()

    # 1. Importera karaktären (mesh + armature + T-pose)
    try:
        bpy.ops.import_scene.fbx(filepath=char_path)
    except Exception as e:
        log(f'FAIL import character: {e}')
        return False

    hero_armature = find_armature()
    if not hero_armature:
        log('FAIL: ingen armature i karaktärs-FBX')
        return False

    # T-pose-actionen som karaktären kommer med — ta bort, vi vill bara
    # ha riktiga animations-clips i GLB-exporten.
    if hero_armature.animation_data and hero_armature.animation_data.action:
        try:
            bpy.data.actions.remove(hero_armature.animation_data.action)
        except Exception:
            pass

    # 2. Importera + assigna alla animationer
    for anim_fbx, target_name in ANIMATIONS:
        anim_path = os.path.join(RAW_DIR, anim_fbx)
        if not os.path.exists(anim_path):
            log(f'  SKIP anim: {anim_fbx} saknas')
            continue
        import_anim_and_rename(anim_path, target_name, hero_armature)

    # 3. Exportera GLB
    out_path = os.path.join(OUT_DIR, f'{out_name}.glb')
    os.makedirs(OUT_DIR, exist_ok=True)
    try:
        bpy.ops.export_scene.gltf(
            filepath=out_path,
            export_format='GLB',
            export_animations=True,
            export_anim_slide_to_zero=True,
            export_nla_strips=True,
            export_apply=False,
            use_selection=False,
        )
        log(f'WROTE: {out_path}')
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
    os.makedirs(OUT_DIR, exist_ok=True)

    ok = 0
    fail = 0
    for char_fbx, out_name in HEROES:
        if convert_hero(char_fbx, out_name):
            ok += 1
        else:
            fail += 1

    log('=' * 40)
    log(f'KLART: {ok} OK, {fail} fail. Output i {OUT_DIR}')


if __name__ == '__main__':
    main()
