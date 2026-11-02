"""Turn a Hunyuan3D GLB into a watertight STL for 3D printing.

Usage: python tools/mesh_to_solid.py input.glb output.stl [height_mm]
Needs: pip install numpy scipy scikit-image trimesh

The raw mesh is usually many open pieces. This voxelizes its surface, fills the
inside, keeps the largest solid and rebuilds a smooth closed surface. It stands
the model on Z=0, assuming the GLB's up axis is Y.
"""
import sys

import numpy as np
import trimesh
from scipy import ndimage as ni
from skimage import measure

GRID = 260
SAMPLES = 12_000_000


def to_solid(src: str, dst: str, height_mm: float = 100.0) -> None:
    mesh = trimesh.load(src, force="mesh")
    pitch = mesh.extents.max() / GRID
    points, _ = trimesh.sample.sample_surface(mesh, SAMPLES)
    origin = mesh.bounds[0] - 3 * pitch
    grid = np.zeros(np.ceil(mesh.extents / pitch).astype(int) + 7, bool)
    i = ((points - origin) / pitch).astype(int)
    grid[i[:, 0], i[:, 1], i[:, 2]] = True

    solid = ni.binary_fill_holes(ni.binary_closing(grid, iterations=2))
    labels, count = ni.label(solid)
    sizes = ni.sum(solid, labels, range(1, count + 1))
    solid = labels == (np.argmax(sizes) + 1)

    verts, faces, _, _ = measure.marching_cubes(ni.gaussian_filter(solid.astype(float), 1.0), 0.5)
    result = trimesh.Trimesh(verts * pitch + origin, faces, process=True)
    if result.volume < 0:
        result.invert()

    result.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0]))
    result.apply_translation([0, 0, -result.bounds[0][2]])
    result.apply_scale(height_mm / result.extents[2])
    if not result.is_watertight:
        raise RuntimeError("Rebuilt mesh is not watertight; try a higher GRID")
    result.export(dst)
    print(f"[mesh_to_solid] {dst}: {result.extents.round(1)} mm, {result.volume / 1000:.1f} cm3, watertight")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    to_solid(sys.argv[1], sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 100.0)
