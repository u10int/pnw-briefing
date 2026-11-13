/** A regular lon/lat grid: rows north to south, columns west to east. */
export interface Grid {
  width: number; height: number
  west: number; south: number; east: number; north: number
}
