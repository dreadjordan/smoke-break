# Keys, grades, crops and encodes Smoke Break's green-screen footage into the app's alpha WebM clips and footage-track.js.
# Uses a clean plate (empty green frames) for an exact matte and edge colour recovery. Run: python3 tools/key_footage.py [takedown] (needs numpy, pillow).
import os, subprocess, sys, numpy as np
from PIL import Image

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(PROJECT, '00006.MTS')
ASSETS = os.path.join(PROJECT, 'src', 'assets')
WIDTH, HEIGHT = 1920, 1080
FPS = '60000/1001'
# Seconds into the take: empty green for the plate, the hand bringing the cigarette up and into the mouth, then a steady
# stretch in the mouth (it ends before the hand comes back for the cigarette at about 10s).
PLATE = (0.0, 0.6)
ENTRY = (0.6, 5.6)
LOOP = (5.6, 9.6)
# The hand comes back, takes the cigarette from the lips and carries it down and out of frame; played at its filmed speed.
# Why: the third value decodes from that many seconds earlier; seeking straight to a mid-GOP point here froze the first frames on a later pose.
TAKEDOWN = (9.8, 10.47, 2)
# Why: the filmed gesture is unhurried; the entry is sped up by keeping every ENTRY_SPEED-th frame, so it plays at its
# normal rate (decoding a 60fps alpha clip at 3x in the browser would stutter).
ENTRY_SPEED = 3.3
# White balance and exposure, measured off the cigarette paper (p90 0.537, 0.537, 0.482) so it lands near white.
GAIN = np.array([0.88 / 0.537, 0.88 / 0.537, 0.86 / 0.482], dtype=np.float32)


def frames(start, end, preroll=0):
    process = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', str(start - preroll), '-i', SOURCE, '-vf', 'bwdif=mode=send_field',
                                '-ss', str(preroll), '-t', str(end - start), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
    size = WIDTH * HEIGHT * 3
    while True:
        raw = process.stdout.read(size)
        if len(raw) < size:
            break
        yield np.frombuffer(raw, np.uint8).reshape(HEIGHT, WIDTH, 3).astype(np.float32) / 255


def erode(alpha):
    out = alpha.copy()
    out[1:] = np.minimum(out[1:], alpha[:-1]); out[:-1] = np.minimum(out[:-1], alpha[1:])
    out[:, 1:] = np.minimum(out[:, 1:], alpha[:, :-1]); out[:, :-1] = np.minimum(out[:, :-1], alpha[:, 1:])
    return out


def box_blur(image, radius):
    for axis in (0, 1):
        padded = np.concatenate([np.repeat(np.take(image, [0], axis), radius + 1, axis), image,
                                 np.repeat(np.take(image, [-1], axis), radius, axis)], axis)
        summed = np.cumsum(padded, axis=axis, dtype=np.float32)
        length = image.shape[axis]
        image = (np.take(summed, range(2 * radius + 1, 2 * radius + 1 + length), axis)
                 - np.take(summed, range(length), axis)) / (2 * radius + 1)
    return image


# Why: soft edge pixels carry a mix of recovered colour, sharpening halo and spill, which reads as an outline; and 4:2:0
# video shares chroma between neighbouring pixels, so edges also pick up whatever colour the transparent pixels hold.
# Replacing every non-solid pixel's colour with the nearby solid colour (and padding it outward) removes both.
def bleed_edge_colour(colour, alpha):
    core = erode((alpha > 0.97).astype(np.float32))
    filled = core > 0
    result = colour.copy()
    for radius in (3, 8, 24):
        weight = box_blur(core, radius)
        mean = box_blur(colour * core[..., None], radius) / np.maximum(weight, 1e-6)[..., None]
        update = ~filled & (weight > 1e-4)
        result[update] = mean[update]
        filled |= update
    result[~filled] = 0
    return result


def key(frame, plate, plate_excess):
    excess = frame[..., 1] - np.maximum(frame[..., 0], frame[..., 2])
    alpha = 1 - np.clip((excess / plate_excess - 0.25) / 0.55, 0, 1)
    # Anything that matches the clean plate is background, whatever its colour.
    alpha[np.abs(frame - plate).max(axis=2) < 0.035] = 0
    # Pull the matte in half a pixel to drop the camera's sharpening halo, and trim the faint low end.
    alpha = np.clip((0.5 * alpha + 0.5 * erode(alpha) - 0.08) / 0.92, 0, 1)
    safe = np.maximum(alpha, 1e-3)[..., None]
    colour = np.clip((frame - (1 - alpha[..., None]) * plate) / safe, 0, 1)
    # Why: capping green at max(red, blue) still lets spill lift skin's green up to its red, which reads as an olive outline;
    # capping at their average removes that while leaving clean skin (green already below it) untouched.
    colour[..., 1] = np.minimum(colour[..., 1], (colour[..., 0] + colour[..., 2]) / 2)
    colour = np.clip(colour * GAIN, 0, 1)
    return colour, alpha


def resampled(source, speed):
    next_pick = 0.0
    for index, frame in enumerate(source):
        if index + 1e-6 >= next_pick:
            next_pick += speed
            yield frame


def crop_for(span, pad=24, speed=1):
    union = np.zeros((HEIGHT, WIDTH), bool)
    for frame in resampled(frames(*span), speed):
        union |= key(frame, plate, plate_excess)[1] > 0.02
    ys, xs = np.nonzero(union)
    x0, y0 = max(0, xs.min() - pad), max(0, ys.min() - pad)
    x1 = min(WIDTH, xs.max() + pad)
    # Even sizes keep the 4:2:0 encoder happy.
    x0 -= x0 % 2
    y0 -= y0 % 2
    x1 -= (x1 - x0) % 2
    return int(x0), int(y0), int(x1), HEIGHT


def cropped(span, crop, coverage=None, speed=1):
    x0, y0, x1, y1 = crop
    for frame in resampled(frames(*span), speed):
        colour, alpha = key(frame, plate, plate_excess)
        colour = bleed_edge_colour(colour[y0:y1, x0:x1], alpha[y0:y1, x0:x1])
        alpha = alpha[y0:y1, x0:x1]
        if coverage is not None:
            coverage.append(int((alpha > 0.02).sum()))
        yield (np.dstack([colour, alpha]) * 255 + 0.5).astype(np.uint8)


def encode(rgba_frames, crop, path):
    x0, y0, x1, y1 = crop
    encoder = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{x1 - x0}x{y1 - y0}', '-r', FPS,
                                '-i', '-', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '24', '-b:v', '0', '-row-mt', '1',
                                '-auto-alt-ref', '0', '-an', path], stdin=subprocess.PIPE)
    count = 0
    for rgba in rgba_frames:
        encoder.stdin.write(rgba.tobytes())
        count += 1
    encoder.stdin.close()
    encoder.wait()
    return count


def track(alpha):
    # The cigarette's centre line (x = a + b*y) and top, from the opaque core of the matte, in crop pixels.
    rows = np.nonzero((alpha > 0.5).sum(axis=1) > 6)[0]
    centres = np.array([np.nonzero(alpha[row] > 0.5)[0].mean() for row in rows])
    widths = np.array([(alpha[row] > 0.5).sum() for row in rows])
    slope, intercept = np.polyfit(rows, centres, 1)
    full = rows[widths > 0.7 * np.median(widths)]
    return [int(full.min()), round(float(intercept), 2), round(float(slope), 4), round(float(np.median(widths)) / 2, 2)]


def smooth(values, sigma=120):
    radius = int(sigma * 3)
    kernel = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    padded = np.pad(np.asarray(values, np.float64), radius, mode='reflect')
    return np.convolve(padded, kernel / kernel.sum(), mode='valid')


# Why: handheld head movement made the in-mouth cigarette rock; each frame is moved and turned (about the lips, at the
# bottom edge) so it keeps only this much of its deviation from a slow, smoothed path.
KEPT_MOVEMENT = 0.25
BOTTOM_EXTENSION = 120


def stabilise(rgba_frames):
    height, width = rgba_frames[0].shape[:2]
    tracks = np.array([track(rgba[..., 3].astype(np.float32) / 255) for rgba in rgba_frames], np.float64)
    tops, bottoms, slopes = tracks[:, 0], tracks[:, 1] + tracks[:, 2] * height, tracks[:, 2]
    targets = [smoothed + KEPT_MOVEMENT * (raw - smoothed) for raw, smoothed in ((series, smooth(series)) for series in (tops, bottoms, slopes))]
    stabilised = []
    for rgba, top, bottom, slope, target_top, target_bottom, target_slope in zip(rgba_frames, tops, bottoms, slopes, *targets):
        # The cigarette continues below the frame edge, so repeating the bottom rows lets it shift up without exposing a cut end.
        extended = np.concatenate([rgba, np.repeat(rgba[-1:], BOTTOM_EXTENSION, axis=0)])
        angle = np.arctan2(1, target_slope) - np.arctan2(1, slope)
        cos, sin = np.cos(angle), np.sin(angle)
        pivot_out = (target_bottom, height + (target_top - top))
        pivot_in = (bottom, height)
        coefficients = (cos, sin, pivot_in[0] - cos * pivot_out[0] - sin * pivot_out[1],
                        -sin, cos, pivot_in[1] + sin * pivot_out[0] - cos * pivot_out[1])
        moved = Image.fromarray(extended, 'RGBA').transform((width, height), Image.AFFINE, coefficients, resample=Image.BICUBIC)
        stabilised.append(np.asarray(moved))
    print('stabilised: top range', round(np.ptp(tops), 1), '->', round(np.ptp(targets[0]), 1),
          'bottom x range', round(np.ptp(bottoms), 1), '->', round(np.ptp(targets[1]), 1), flush=True)
    return stabilised


# The tip and direction of the cigarette, from its white paper alone so the hand holding it doesn't pull the fit.
def track_paper(rgba):
    colour = rgba[..., :3].astype(np.float32) / 255
    paper = (rgba[..., 3] > 150) & (colour.min(axis=2) > 0.55) & (np.ptp(colour, axis=2) < 0.18)
    ys, xs = np.nonzero(paper)
    if len(xs) < 400:
        return None
    points = np.stack([xs, ys], 1).astype(np.float64)
    for _ in range(3):
        centre = np.median(points, axis=0)
        direction = np.linalg.svd(points - centre, full_matrices=False)[2][0]
        across = (points - centre) @ np.array([-direction[1], direction[0]])
        points = points[np.abs(across) < 2.2 * np.median(np.abs(across)) + 4]
    # The tip is the upper end, or the left end once it has tipped over toward level.
    if direction[1] > 0.15 or (abs(direction[1]) <= 0.15 and direction[0] > 0):
        direction = -direction
    along = (points - centre) @ direction
    across = (points - centre) @ np.array([-direction[1], direction[0]])
    tip = centre + direction * np.percentile(along, 99.5)
    return [tip[0], tip[1], np.arctan2(direction[0], -direction[1]), 2 * np.abs(across).mean()]


def steady(rows, radius=2):
    rows = np.array(rows, np.float64)
    padded = np.pad(rows, ((radius, radius), (0, 0)), mode='edge')
    return np.stack([padded[index:index + 2 * radius + 1].mean(axis=0) for index in range(len(rows))])


def key_takedown():
    crop = crop_for(TAKEDOWN)
    clip = list(cropped(TAKEDOWN, crop))
    print('takedown', encode(clip, crop, os.path.join(ASSETS, 'takedown.webm')), 'frames, crop', crop, flush=True)
    rows, last = [], None
    for rgba in clip:
        last = track_paper(rgba) or last
        rows.append(last)
    first = next(row for row in rows if row)
    rows = steady([row or first for row in rows])
    text = ',\n'.join('    [' + ', '.join(f'{value:.3f}' if index == 2 else f'{value:.1f}' for index, value in enumerate(row)) + ']' for row in rows)
    with open(os.path.join(PROJECT, 'src', 'takedown-track.js'), 'w') as output:
        output.write(f"""// Generated by tools/key_footage.py: where the cigarette is in each frame of the clip of it being taken from the mouth.
// The crop is [left, top, right, bottom] in source pixels; each row is [tip x, tip y, tilt from upright in radians, half width] in crop pixels.
'use strict';

const TAKEDOWN_TRACK = {{
  fps: {60000 / 1001},
  crop: {list(crop)},
  frames: [
{text},
  ],
}};
""")


plate = np.median(np.stack(list(frames(*PLATE))), axis=0)
plate_excess = np.maximum(plate[..., 1] - np.maximum(plate[..., 0], plate[..., 2]), 1e-3)

key_takedown()
if sys.argv[1:] == ['takedown']:
    sys.exit()

entry_crop = crop_for(ENTRY, speed=ENTRY_SPEED)
entry_coverage = []
print('entry', encode(cropped(ENTRY, entry_crop, entry_coverage, speed=ENTRY_SPEED), entry_crop, os.path.join(ASSETS, 'entry.webm')), 'frames, crop', entry_crop, flush=True)
# The empty stretch between the hand leaving frame and the cigarette rising into the mouth; the app changes framing there.
first_seen = next(index for index, pixels in enumerate(entry_coverage) if pixels > 0)
gaps, start = [], None
for index, pixels in enumerate(entry_coverage[first_seen:], first_seen):
    if pixels == 0 and start is None:
        start = index
    elif pixels > 0 and start is not None:
        gaps.append((start, index))
        start = None
gap = max(gaps, key=lambda span: span[1] - span[0])
entry_switch = round((gap[0] + gap[1]) / 2 / (60000 / 1001), 3)
# Playback starts a few frames before the hand first appears, skipping the empty lead-in.
entry_start = round(max(0, first_seen - 3) / (60000 / 1001), 3)
print('entry gap frames', gap, 'switch at', entry_switch, 's', flush=True)

loop_crop = crop_for(LOOP)
loop = stabilise(list(cropped(LOOP, loop_crop)))
# Forward then backward (without repeating the turnaround frames), so the clip loops with no seam.
pingpong = loop + loop[-2:0:-1]
print('loop', encode(pingpong, loop_crop, os.path.join(ASSETS, 'loop.webm')), 'frames, crop', loop_crop, flush=True)
rows = ',\n'.join('    [' + ', '.join(str(value) for value in track(rgba[..., 3].astype(np.float32) / 255)) + ']' for rgba in pingpong)
with open(os.path.join(PROJECT, 'src', 'footage-track.js'), 'w') as output:
    output.write(f"""// Generated by tools/key_footage.py: where the keyed clips sit in the 1920x1080 source frame, and where the cigarette is in each loop frame.
// Crops are [left, top, right, bottom] in source pixels; each loop row is [top of cigarette, centre-line x at y=0, centre-line slope, half width] in loop-crop pixels.
'use strict';

const FOOTAGE_TRACK = {{
  fps: {60000 / 1001},
  entryCrop: {list(entry_crop)},
  // Seconds into the entry clip where playback starts, just before the hand first appears.
  entryStart: {entry_start},
  // Seconds into the entry clip, inside the empty stretch between the hand leaving and the cigarette rising into the mouth.
  entrySwitch: {entry_switch},
  loopCrop: {list(loop_crop)},
  loop: [
{rows},
  ],
}};
""")
