#!/usr/bin/env python3
"""Generate every static asset of the golf pack: manifests, blocks, items,
entities, models, particles, animations, language and textures.

    python3 golf/maker/make_assets.py

Re-run after changing anything here. Scripts (pack/BP/scripts) are hand-written
and are not touched. Textures are drawn procedurally (no copyrighted art).
"""
from __future__ import annotations

import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1] / "pack"
BP = ROOT / "BP"
RP = ROOT / "RP"

VERSION = [0, 1, 0]
BP_UUID = "6b12fd64-ac7c-42fd-8130-b2664d67c522"
BP_DATA_UUID = "cfd5c3b7-e2cd-4d52-8280-f4b04951ad54"
BP_SCRIPT_UUID = "ba884352-e1df-4b75-b453-1c98d6c4f6a1"
RP_UUID = "63cc8ebf-6e7e-404c-8054-fe05243f0c0f"
RP_MODULE_UUID = "2f0e4f7c-5b1e-4d3a-9c77-0a6a2b1f5e10"

SERVER_API = "2.6.0"     # stable @minecraft/server, Minecraft 1.26.10+
SERVER_UI_API = "2.0.0"  # stable @minecraft/server-ui
MIN_ENGINE = [1, 26, 10]
BLOCK_FMT = "1.21.60"
ITEM_FMT = "1.21.60"
ENTITY_FMT = "1.21.60"

rnd = random.Random(42)


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


# ---------------------------------------------------------------------------
# Manifests
# ---------------------------------------------------------------------------

def manifests() -> None:
    write_json(BP / "manifest.json", {
        "format_version": 2,
        "header": {
            "name": "Finsonly Golf",
            "description": "Mario-style golf with a course builder and famous holes. Behavior pack.",
            "uuid": BP_UUID, "version": VERSION, "min_engine_version": MIN_ENGINE,
        },
        "modules": [
            {"type": "data", "uuid": BP_DATA_UUID, "version": VERSION},
            {"type": "script", "language": "javascript", "uuid": BP_SCRIPT_UUID, "version": VERSION, "entry": "scripts/main.js"},
        ],
        "dependencies": [
            {"uuid": RP_UUID, "version": VERSION},
            {"module_name": "@minecraft/server", "version": SERVER_API},
            {"module_name": "@minecraft/server-ui", "version": SERVER_UI_API},
        ],
        "metadata": {"authors": ["Eric"], "product_type": "addon"},
    })
    write_json(RP / "manifest.json", {
        "format_version": 2,
        "header": {
            "name": "Finsonly Golf Resources",
            "description": "Textures, models and effects for Finsonly Golf.",
            "uuid": RP_UUID, "version": VERSION, "min_engine_version": MIN_ENGINE,
        },
        "modules": [{"type": "resources", "uuid": RP_MODULE_UUID, "version": VERSION}],
        "dependencies": [{"uuid": BP_UUID, "version": VERSION}],
    })


# ---------------------------------------------------------------------------
# Blocks
# ---------------------------------------------------------------------------

# id suffix: (display name, top texture, side texture, map color, sound, seconds to break)
BLOCKS = {
    "turf_tee_a": ("Tee Box Turf", "golf_tee_a", "golf_side_tee", "#62b84a", "grass", 0.6),
    "turf_tee_b": ("Tee Box Turf (stripe)", "golf_tee_b", "golf_side_tee", "#57a842", "grass", 0.6),
    "turf_fairway_a": ("Fairway Turf", "golf_fairway_a", "golf_side_fairway", "#5cb53f", "grass", 0.6),
    "turf_fairway_b": ("Fairway Turf (stripe)", "golf_fairway_b", "golf_side_fairway", "#4fa337", "grass", 0.6),
    "turf_fringe": ("Fringe Turf", "golf_fringe", "golf_side_fairway", "#56ad3c", "grass", 0.6),
    "turf_green_a": ("Putting Green", "golf_green_a", "golf_side_green", "#6fd04c", "grass", 0.6),
    "turf_green_b": ("Putting Green (stripe)", "golf_green_b", "golf_side_green", "#63c244", "grass", 0.6),
    "turf_rough": ("Rough", "golf_rough", "golf_side_rough", "#3f8a2f", "grass", 0.6),
    "turf_deep_rough": ("Deep Rough", "golf_deep_rough", "golf_side_rough", "#2f6e24", "grass", 0.6),
    "bunker_sand": ("Bunker Sand", "golf_bunker", "golf_bunker", "#e6d6a2", "sand", 0.5),
    "cart_path": ("Cart Path", "golf_path", "golf_path_side", "#8f8f8a", "stone", 1.0),
    "cup": ("Golf Cup", "golf_cup", "golf_side_green", "#6fd04c", "grass", 0.6),
}


def blocks() -> None:
    sounds = {"format_version": [1, 1, 0]}
    for suffix, (name, top, side, color, sound, secs) in BLOCKS.items():
        ident = f"golf:{suffix}"
        write_json(BP / "blocks" / f"{suffix}.json", {
            "format_version": BLOCK_FMT,
            "minecraft:block": {
                "description": {"identifier": ident, "menu_category": {"category": "nature"}},
                "components": {
                    "minecraft:destructible_by_mining": {"seconds_to_destroy": secs},
                    "minecraft:destructible_by_explosion": {"explosion_resistance": 1},
                    "minecraft:map_color": color,
                    "minecraft:geometry": "minecraft:geometry.full_block",
                    "minecraft:material_instances": {
                        "*": {"texture": side, "render_method": "opaque"},
                        "up": {"texture": top, "render_method": "opaque"},
                        "down": {"texture": "golf_dirt", "render_method": "opaque"},
                    },
                },
            },
        })
        sounds[ident] = {"sound": sound}
    write_json(RP / "blocks.json", sounds)


# ---------------------------------------------------------------------------
# Items
# ---------------------------------------------------------------------------

ITEMS = {
    "club": ("Golf Club", "golf_club"),
    "course_wand": ("Course Wand", "golf_wand"),
    "course_brush": ("Course Brush", "golf_brush"),
}


def items() -> None:
    for suffix, (_name, icon) in ITEMS.items():
        write_json(BP / "items" / f"{suffix}.json", {
            "format_version": ITEM_FMT,
            "minecraft:item": {
                "description": {"identifier": f"golf:{suffix}", "menu_category": {"category": "equipment"}},
                "components": {
                    "minecraft:icon": icon,
                    "minecraft:max_stack_size": 1,
                    "minecraft:hand_equipped": True,
                    "minecraft:allow_off_hand": False,
                    "minecraft:can_destroy_in_creative": False,
                    "minecraft:glint": suffix != "club",
                    # A long "use" so one button press = one itemStartUse, and holding doesn't repeat.
                    "minecraft:use_modifiers": {"use_duration": 3600, "movement_modifier": 1.0},
                },
            },
        })


# ---------------------------------------------------------------------------
# Entities (behavior + client), models, render controllers
# ---------------------------------------------------------------------------

def inert(collision_w: float, collision_h: float, family: list[str], extra: dict | None = None) -> dict:
    c = {
        "minecraft:collision_box": {"width": collision_w, "height": collision_h},
        "minecraft:physics": {"has_gravity": False, "has_collision": False},
        "minecraft:pushable": {"is_pushable": False, "is_pushable_by_piston": False},
        "minecraft:damage_sensor": {"triggers": [{"cause": "all", "deals_damage": "no"}]},
        "minecraft:health": {"value": 1, "max": 1},
        "minecraft:knockback_resistance": {"value": 1.0},
        "minecraft:type_family": {"family": family + ["inanimate"]},
        "minecraft:persistent": {},
    }
    c.update(extra or {})
    return c


def entities() -> None:
    defs = {
        "ball": inert(0.2, 0.2, ["golf_ball"], {"minecraft:nameable": {"always_show": False, "allow_name_tag_renaming": False}}),
        "pin": inert(0.25, 2.6, ["golf_pin"], {"minecraft:nameable": {"always_show": True, "allow_name_tag_renaming": False}}),
        "tee_marker": inert(0.35, 0.35, ["golf_tee"]),
        "club_rack": inert(0.9, 1.4, ["golf_rack"], {
            "minecraft:nameable": {"always_show": True, "allow_name_tag_renaming": False},
            "minecraft:interact": {"interactions": [{
                "on_interact": {"filters": {"test": "is_family", "subject": "other", "value": "player"}},
                "interact_text": "action.interact.golf_rack",
                "swing": True,
            }]},
        }),
    }
    for name, comps in defs.items():
        desc = {"identifier": f"golf:{name}", "is_spawnable": False, "is_summonable": True, "is_experimental": False}
        if name == "tee_marker":
            desc["properties"] = {"golf:color": {"type": "int", "range": [0, 3], "default": 0, "client_sync": True}}
        write_json(BP / "entities" / f"{name}.json", {
            "format_version": ENTITY_FMT,
            "minecraft:entity": {"description": desc, "components": comps},
        })

    # client entities
    def client(name, textures, geo, rc="controller.render.golf_default"):
        write_json(RP / "entity" / f"{name}.entity.json", {
            "format_version": "1.10.0",
            "minecraft:client_entity": {"description": {
                "identifier": f"golf:{name}",
                "materials": {"default": "entity_alphatest"},
                "textures": textures,
                "geometry": {"default": geo},
                "render_controllers": [rc],
            }},
        })

    client("ball", {"default": "textures/entity/golf/ball"}, "geometry.golf.ball")
    client("pin", {"default": "textures/entity/golf/pin"}, "geometry.golf.pin")
    client("club_rack", {"default": "textures/entity/golf/rack"}, "geometry.golf.rack")
    client("tee_marker", {
        "blue": "textures/entity/golf/tee_blue", "white": "textures/entity/golf/tee_white",
        "red": "textures/entity/golf/tee_red", "gold": "textures/entity/golf/tee_gold",
    }, "geometry.golf.tee", "controller.render.golf_tee")

    write_json(RP / "render_controllers" / "golf.render_controllers.json", {
        "format_version": "1.8.0",
        "render_controllers": {
            "controller.render.golf_default": {
                "geometry": "Geometry.default", "materials": [{"*": "Material.default"}], "textures": ["Texture.default"],
            },
            "controller.render.golf_tee": {
                "arrays": {"textures": {"Array.colors": ["Texture.blue", "Texture.white", "Texture.red", "Texture.gold"]}},
                "geometry": "Geometry.default", "materials": [{"*": "Material.default"}],
                "textures": ["Array.colors[query.property('golf:color')]"],
            },
        },
    })

    def geo(ident, tw, th, bones):
        write_json(RP / "models" / "entity" / f"{ident.split('.')[-1]}.geo.json", {
            "format_version": "1.12.0",
            "minecraft:geometry": [{
                "description": {"identifier": ident, "texture_width": tw, "texture_height": th,
                                "visible_bounds_width": 3, "visible_bounds_height": 4, "visible_bounds_offset": [0, 1.5, 0]},
                "bones": bones,
            }],
        })

    geo("geometry.golf.ball", 16, 16, [{"name": "ball", "pivot": [0, 0, 0], "cubes": [
        {"origin": [-1.5, 0, -1.5], "size": [3, 3, 3], "uv": [0, 0]}]}])
    geo("geometry.golf.tee", 16, 16, [{"name": "tee", "pivot": [0, 0, 0], "cubes": [
        {"origin": [-2.5, 0, -2.5], "size": [5, 5, 5], "uv": [0, 0]}]}])
    geo("geometry.golf.pin", 32, 32, [
        {"name": "pole", "pivot": [0, 0, 0], "cubes": [{"origin": [-0.5, 0, -0.5], "size": [1, 40, 1], "uv": [0, 0]}]},
        {"name": "flag", "parent": "pole", "pivot": [0, 40, 0], "cubes": [{"origin": [0.5, 31, -0.25], "size": [12, 9, 0.5], "uv": [4, 0]}]},
    ])
    geo("geometry.golf.rack", 64, 64, [
        {"name": "bag", "pivot": [0, 0, 0], "cubes": [
            {"origin": [-4, 0, -4], "size": [8, 16, 8], "uv": [0, 0]},
            {"origin": [-5, 13, -5], "size": [10, 2, 10], "uv": [0, 24]},
        ]},
        {"name": "clubs", "parent": "bag", "pivot": [0, 16, 0], "cubes": [
            {"origin": [-3, 16, -2], "size": [1, 6, 1], "uv": [32, 0]},
            {"origin": [-1, 16, 1], "size": [1, 7, 1], "uv": [32, 0]},
            {"origin": [1, 16, -1], "size": [1, 5, 1], "uv": [32, 0]},
            {"origin": [-4, 21, -3], "size": [3, 2, 3], "uv": [36, 0]},
            {"origin": [-2, 22, 0], "size": [3, 2, 3], "uv": [36, 0]},
            {"origin": [0, 20, -2], "size": [3, 2, 3], "uv": [36, 0]},
        ]},
    ])


# ---------------------------------------------------------------------------
# Particles, animations, language
# ---------------------------------------------------------------------------

def particle(name, lifetime, size, speed_expr="0", drag=0.0, gravity=0.0):
    comps = {
        "minecraft:emitter_rate_instant": {"num_particles": 1},
        "minecraft:emitter_lifetime_once": {"active_time": 0},
        "minecraft:emitter_shape_point": {"direction": ["variable.direction.x", "variable.direction.y", "variable.direction.z"]},
        "minecraft:particle_lifetime_expression": {"max_lifetime": lifetime},
        "minecraft:particle_initial_speed": speed_expr,
        "minecraft:particle_motion_dynamic": {"linear_acceleration": [0, -gravity, 0], "linear_drag_coefficient": drag},
        "minecraft:particle_appearance_billboard": {
            "size": [size, size], "facing_camera_mode": "rotate_xyz",
            "uv": {"texture_width": 8, "texture_height": 8, "uv": [0, 0], "uv_size": [8, 8]},
        },
        "minecraft:particle_appearance_tinting": {"color": [
            "variable.color.r", "variable.color.g", "variable.color.b",
            f"variable.color.a * (1 - math.pow(variable.particle_age / {lifetime}, 3))"]},
    }
    write_json(RP / "particles" / f"{name}.json", {
        "format_version": "1.10.0",
        "particle_effect": {
            "description": {"identifier": f"golf:{name}", "basic_render_parameters": {"material": "particles_blend", "texture": "textures/particle/golf_dot"}},
            "components": comps,
        },
    })


def particles():
    particle("aim_dot", 0.22, 0.12)
    particle("trail", 0.9, 0.1)
    speed = "math.sqrt(variable.direction.x * variable.direction.x + variable.direction.z * variable.direction.z)"
    particle("slope_dot", 0.55, 0.09, speed_expr=speed)


def animations():
    write_json(RP / "animations" / "golf.animation.json", {
        "format_version": "1.10.0",
        "animations": {
            "animation.golf.swing": {"animation_length": 0.7, "bones": {
                "rightArm": {"rotation": {"0.0": [0, 0, 0], "0.25": [-150, 40, 0], "0.4": [30, -50, 0], "0.7": [-120, -70, 0]}},
                "leftArm": {"rotation": {"0.0": [0, 0, 0], "0.25": [-150, 40, 0], "0.4": [30, -50, 0], "0.7": [-120, -70, 0]}},
                "body": {"rotation": {"0.0": [0, 0, 0], "0.25": [0, 35, 0], "0.4": [0, -10, 0], "0.7": [0, -40, 0]}},
            }},
            "animation.golf.putt": {"animation_length": 0.5, "bones": {
                "rightArm": {"rotation": {"0.0": [-20, 0, 0], "0.2": [-45, 15, 0], "0.35": [-5, -15, 0], "0.5": [-20, 0, 0]}},
                "leftArm": {"rotation": {"0.0": [-20, 0, 0], "0.2": [-45, 15, 0], "0.35": [-5, -15, 0], "0.5": [-20, 0, 0]}},
            }},
        },
    })


def lang():
    lines = [f"item.golf:{k}={v[0]}" for k, v in ITEMS.items()]
    lines += [f"tile.golf:{k}.name={v[0]}" for k, v in BLOCKS.items()]
    lines += [
        "entity.golf:ball.name=Golf Ball", "entity.golf:pin.name=Flagstick",
        "entity.golf:tee_marker.name=Tee Marker", "entity.golf:club_rack.name=Golf Clubs",
        "action.interact.golf_rack=Get Clubs",
        "pack.name=Finsonly Golf", "pack.description=Mario-style golf and a course builder",
    ]
    for pack in (RP, BP):
        (pack / "texts").mkdir(parents=True, exist_ok=True)
        (pack / "texts" / "en_US.lang").write_text("\n".join(lines) + "\n")
        write_json(pack / "texts" / "languages.json", ["en_US"])


# ---------------------------------------------------------------------------
# Textures
# ---------------------------------------------------------------------------

def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def jitter(c, amt):
    return tuple(max(0, min(255, v + rnd.randint(-amt, amt))) for v in c)


def turf(base, noise=10, blades=0, blade_col=None, size=16, seed=0):
    rnd.seed(seed)
    im = Image.new("RGBA", (size, size))
    px = im.load()
    for y in range(size):
        for x in range(size):
            px[x, y] = (*jitter(base, noise), 255)
    for _ in range(blades):
        x, y = rnd.randrange(size), rnd.randrange(size)
        px[x, y] = (*jitter(blade_col or base, 6), 255)
    return im


def side(top_col, strip=3, seed=0):
    rnd.seed(seed)
    im = Image.new("RGBA", (16, 16))
    px = im.load()
    dirt = hexrgb("#7a5534")
    for y in range(16):
        for x in range(16):
            edge = strip + (1 if (x * 7 + seed) % 5 == 0 else 0)
            px[x, y] = (*jitter(top_col if y < edge else dirt, 10 if y >= edge else 8), 255)
    return im


def textures():
    T = RP / "textures"
    blocks_dir = T / "blocks"
    blocks_dir.mkdir(parents=True, exist_ok=True)
    tex = {}

    def save(name, im, folder="blocks"):
        p = T / folder / f"{name}.png"
        p.parent.mkdir(parents=True, exist_ok=True)
        im.save(p)
        return f"textures/{folder}/{name}"

    tex["golf_fairway_a"] = save("golf_fairway_a", turf(hexrgb("#62bd44"), 9, 10, hexrgb("#73cc52"), seed=1))
    tex["golf_fairway_b"] = save("golf_fairway_b", turf(hexrgb("#52a83a"), 9, 10, hexrgb("#5fb846"), seed=2))
    tex["golf_tee_a"] = save("golf_tee_a", turf(hexrgb("#68c24a"), 7, 6, hexrgb("#78d058"), seed=3))
    tex["golf_tee_b"] = save("golf_tee_b", turf(hexrgb("#5aae40"), 7, 6, hexrgb("#69bd4d"), seed=4))
    tex["golf_green_a"] = save("golf_green_a", turf(hexrgb("#74d651"), 4, 0, seed=5))
    tex["golf_green_b"] = save("golf_green_b", turf(hexrgb("#66c747"), 4, 0, seed=6))
    tex["golf_fringe"] = save("golf_fringe", turf(hexrgb("#5bb540"), 7, 8, hexrgb("#6ac64c"), seed=7))
    tex["golf_rough"] = save("golf_rough", turf(hexrgb("#428f31"), 14, 40, hexrgb("#2f7024"), seed=8))
    tex["golf_deep_rough"] = save("golf_deep_rough", turf(hexrgb("#336f27"), 16, 70, hexrgb("#24561b"), seed=9))
    tex["golf_bunker"] = save("golf_bunker", turf(hexrgb("#e9d9a6"), 10, 18, hexrgb("#d6c38b"), seed=10))
    tex["golf_path"] = save("golf_path", turf(hexrgb("#8e8e88"), 12, 25, hexrgb("#a6a6a0"), seed=11))
    tex["golf_path_side"] = save("golf_path_side", turf(hexrgb("#7d7d77"), 12, 25, hexrgb("#6a6a64"), seed=12))
    tex["golf_dirt"] = save("golf_dirt", turf(hexrgb("#7a5534"), 12, 20, hexrgb("#634228"), seed=13))
    tex["golf_side_fairway"] = save("golf_side_fairway", side(hexrgb("#5cb53f"), seed=14))
    tex["golf_side_tee"] = save("golf_side_tee", side(hexrgb("#62b84a"), seed=15))
    tex["golf_side_green"] = save("golf_side_green", side(hexrgb("#6fd04c"), 2, seed=16))
    tex["golf_side_rough"] = save("golf_side_rough", side(hexrgb("#3f8a2f"), 4, seed=17))
    cup = turf(hexrgb("#74d651"), 4, 0, seed=5)
    d = ImageDraw.Draw(cup)
    d.ellipse([4, 4, 11, 11], fill=(245, 245, 245, 255))
    d.ellipse([5, 5, 10, 10], fill=(28, 24, 20, 255))
    tex["golf_cup"] = save("golf_cup", cup)

    write_json(T / "terrain_texture.json", {
        "resource_pack_name": "finsonly_golf", "texture_name": "atlas.terrain", "padding": 8, "num_mip_levels": 4,
        "texture_data": {k: {"textures": v} for k, v in tex.items()},
    })

    # items
    icons = {}
    club = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    d = ImageDraw.Draw(club)
    d.line([(11, 1), (5, 12)], fill=(60, 60, 66, 255), width=1)        # shaft
    d.line([(12, 1), (11, 3)], fill=(30, 30, 30, 255), width=2)         # grip
    d.polygon([(2, 12), (7, 11), (8, 14), (2, 15)], fill=(200, 205, 212, 255))  # head
    d.line([(2, 15), (8, 14)], fill=(140, 144, 150, 255))
    icons["golf_club"] = save("golf_club", club, "items")
    wand = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    d = ImageDraw.Draw(wand)
    d.line([(4, 15), (4, 2)], fill=(240, 240, 240, 255), width=1)
    d.polygon([(5, 2), (13, 5), (5, 8)], fill=(220, 40, 40, 255))
    d.ellipse([2, 13, 7, 15], fill=(110, 200, 80, 255))
    icons["golf_wand"] = save("golf_wand", wand, "items")
    brush = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    d = ImageDraw.Draw(brush)
    d.line([(13, 2), (7, 8)], fill=(150, 100, 50, 255), width=2)
    d.rectangle([5, 8, 8, 10], fill=(180, 180, 190, 255))
    d.polygon([(4, 10), (8, 10), (5, 15), (2, 14)], fill=(90, 190, 70, 255))
    icons["golf_brush"] = save("golf_brush", brush, "items")
    write_json(T / "item_texture.json", {
        "resource_pack_name": "finsonly_golf", "texture_name": "atlas.items",
        "texture_data": {k: {"textures": v} for k, v in icons.items()},
    })

    # particle dot
    dot = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
    ImageDraw.Draw(dot).ellipse([0, 0, 7, 7], fill=(255, 255, 255, 255))
    save("golf_dot", dot, "particle")

    # entities
    ball = Image.new("RGBA", (16, 16), (250, 250, 250, 255))
    bp = ball.load()
    for _ in range(14):
        bp[rnd.randrange(16), rnd.randrange(16)] = (222, 222, 226, 255)
    save("ball", ball, "entity/golf")
    for name, col in {"tee_blue": "#2f5fd0", "tee_white": "#f2f2f2", "tee_red": "#d43a2f", "tee_gold": "#e8b82a"}.items():
        im = Image.new("RGBA", (16, 16), (*hexrgb(col), 255))
        p2 = im.load()
        for y in range(16):
            for x in range(16):
                if y < 3:
                    p2[x, y] = (*[min(255, v + 30) for v in hexrgb(col)], 255)
        save(name, im, "entity/golf")
    pin = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    pp = pin.load()
    for y in range(32):
        for x in range(4):
            pp[x, y] = (230, 40, 40, 255) if (y // 4) % 2 == 0 else (245, 245, 245, 255)
    d = ImageDraw.Draw(pin)
    d.rectangle([4, 0, 31, 12], fill=(250, 210, 40, 255))   # flag cloth (yellow, classic)
    d.rectangle([4, 0, 31, 1], fill=(230, 180, 30, 255))
    save("pin", pin, "entity/golf")
    rack = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(rack)
    d.rectangle([0, 0, 31, 23], fill=(176, 40, 40, 255))
    for y in range(0, 24, 6):
        d.line([(0, y), (31, y)], fill=(140, 28, 28, 255))
    d.rectangle([0, 24, 39, 35], fill=(60, 50, 40, 255))
    d.rectangle([32, 0, 35, 7], fill=(90, 90, 96, 255))
    d.rectangle([36, 0, 47, 7], fill=(205, 208, 214, 255))
    save("rack", rack, "entity/golf")

    # pack icons
    icon = Image.new("RGBA", (128, 128), (120, 190, 240, 255))
    d = ImageDraw.Draw(icon)
    d.rectangle([0, 80, 127, 127], fill=(98, 189, 68, 255))
    d.ellipse([20, 82, 108, 112], fill=(116, 214, 81, 255))
    d.ellipse([58, 93, 70, 99], fill=(28, 24, 20, 255))
    d.rectangle([63, 22, 65, 96], fill=(245, 245, 245, 255))
    d.polygon([(66, 22), (102, 33), (66, 44)], fill=(250, 210, 40, 255))
    d.ellipse([84, 100, 92, 108], fill=(255, 255, 255, 255))
    icon.save(BP / "pack_icon.png")
    icon.save(RP / "pack_icon.png")


def main():
    manifests()
    blocks()
    items()
    entities()
    particles()
    animations()
    lang()
    textures()
    print("assets written to", ROOT)


if __name__ == "__main__":
    main()
