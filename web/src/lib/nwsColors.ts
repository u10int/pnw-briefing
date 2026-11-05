import { contrastTextColor } from "@/lib/contrast"

/** Official NWS hazard colours by event name (as published at weather.gov/help-map and
 *  xweather.com/docs/maps/reference/alert-types), with readable text on each. */
const COLORS: Record<string, string> = {
  "911 Telephone Outage": "#c0c0c0", "Administrative Message": "#c0c0c0", "Air Quality Alert": "#808080",
  "Air Stagnation Advisory": "#808080", "Arctic Outflow Warning": "#6d97e0", "Ashfall Advisory": "#696969",
  "Ashfall Warning": "#a9a9a9", "Avalanche Advisory": "#cd853f", "Avalanche Warning": "#1e90ff",
  "Avalanche Watch": "#f4a460", "Beach Hazards Statement": "#40e0d0", "Blizzard Warning": "#ff4500",
  "Blowing Dust Advisory": "#bdb76b", "Blowing Dust Warning": "#ffe4c4", "Blowing Snow Advisory": "#add8e6",
  "Blue Alert": "#ffffff", "Brisk Wind Advisory": "#d8bfd8", "Child Abduction Emergency": "#ffffff",
  "Civil Danger Warning": "#ffb6c1", "Civil Emergency Message": "#ffb6c1", "Coastal Flood Advisory": "#7cfc00",
  "Coastal Flood Statement": "#6b8e23", "Coastal Flood Warning": "#228b22", "Coastal Flood Watch": "#66cdaa",
  "Cold Weather Advisory": "#afeeee", "Dense Fog Advisory": "#708090", "Dense Smoke Advisory": "#f0e68c",
  "Dust Advisory": "#bdb76b", "Dust Storm Warning": "#ffe4c4", "Earthquake Warning": "#8b4513",
  "Evacuation Immediate": "#7fff00", "Extreme Cold Warning": "#0000ff", "Extreme Cold Watch": "#5f9ea0",
  "Extreme Fire Danger": "#e9967a", "Extreme Heat Warning": "#c71585", "Extreme Heat Watch": "#800000",
  "Extreme Wind Warning": "#ff8c00", "Fire Warning": "#a0522d", "Fire Weather Watch": "#ffdead",
  "Flash Flood Statement": "#8b0000", "Flash Flood Warning": "#8b0000", "Flash Flood Watch": "#2e8b57",
  "Flash Freeze Warning": "#6d97e0", "Flood Advisory": "#00ff7f", "Flood Statement": "#00ff00",
  "Flood Warning": "#00ff00", "Flood Watch": "#2e8b57", "Freeze Warning": "#483d8b", "Freeze Watch": "#00ffff",
  "Freezing Drizzle Advisory": "#6a5acd", "Freezing Fog Advisory": "#008080", "Freezing Rain Warning": "#8b008b",
  "Freezing Spray Advisory": "#00bfff", "Frost Advisory": "#6495ed", "Gale Warning": "#dda0dd",
  "Gale Watch": "#ffc0cb", "Hazardous Materials Warning": "#4b0082", "Hazardous Seas Warning": "#d8bfd8",
  "Hazardous Seas Watch": "#483d8b", "Hazardous Weather Outlook": "#eee8aa", "Heat Advisory": "#ff7f50",
  "Heat Warning": "#c71585", "Heat Watch": "#800000", "Heavy Freezing Spray Warning": "#00bfff",
  "Heavy Freezing Spray Watch": "#bc8f8f", "Heavy Snow Warning": "#8a2be2", "High Surf Advisory": "#ba55d3",
  "High Surf Warning": "#228b22", "High Wind Warning": "#daa520", "High Wind Watch": "#b8860b",
  "Hurricane Force Wind Warning": "#cd5c5c", "Hurricane Force Wind Watch": "#9932cc", "Hurricane Warning": "#dc143c",
  "Hurricane Watch": "#ff00ff", "Ice Pellets Advisory": "#7b68ee", "Ice Pellets Warning": "#87ceeb",
  "Ice Storm Warning": "#8b008b", "Lake Effect Snow Warning": "#008b8b",
  "Lake Effect and Blowing Snow Advisory": "#87cefa", "Lake Wind Advisory": "#d2b48c",
  "Lakeshore Flood Advisory": "#7cfc00", "Lakeshore Flood Statement": "#6b8e23", "Lakeshore Flood Warning": "#228b22",
  "Lakeshore Flood Watch": "#66cdaa", "Law Enforcement Warning": "#c0c0c0", "Local Area Emergency": "#c0c0c0",
  "Low Water Advisory": "#a52a2a", "Marine Weather Statement": "#ffdab9", "Nuclear Power Plant Warning": "#4b0082",
  "Radiological Hazard Warning": "#4b0082", "Rainfall Warning": "#47ff81", "Red Flag Warning": "#ff1493",
  "Rip Current Statement": "#40e0d0", "Severe Thunderstorm Warning": "#ffa500", "Severe Thunderstorm Watch": "#db7093",
  "Severe Weather Statement": "#00ffff", "Shelter In Place Warning": "#fa8072", "Short Term Forecast": "#98fb98",
  "Small Craft Advisory": "#d8bfd8", "Small Craft Advisory for Hazardous Seas": "#d8bfd8",
  "Small Craft Advisory for Rough Bar": "#d8bfd8", "Small Craft Advisory for Winds": "#d8bfd8",
  "Smog Warning": "#f0e68c", "Snow Squall Warning": "#c71585", "Snow Squall Watch": "#00a09e",
  "Snow and Blowing Snow Advisory": "#b0e0e6", "Snowfall Advisory": "#6699cc", "Snowfall Warning": "#28eef0",
  "Special Marine Warning": "#ffa500", "Special Marine Watch": "#eba400", "Special Weather Advisory": "#ffe4b5",
  "Special Weather Statement": "#ffe4b5", "Squall Warning": "#ff4500", "Squall Watch": "#db7093",
  "Storm Surge Warning": "#b524f7", "Storm Surge Watch": "#db7ff7", "Storm Warning": "#9400d3",
  "Storm Watch": "#ffe4b5", "Tornado Warning": "#ff0000", "Tornado Watch": "#ffff00",
  "Tropical Cyclone Local Statement": "#ffe4b5", "Tropical Storm Warning": "#b22222", "Tropical Storm Watch": "#f08080",
  "Tropical Storm Wind Advisory": "#f08080", "Tropical Storm Wind Warning": "#b22222", "Tsunami Advisory": "#d2691e",
  "Tsunami Warning": "#fd6347", "Tsunami Watch": "#ff00ff", "Typhoon Warning": "#dc143c", "Typhoon Watch": "#ff00ff",
  "Volcano Warning": "#2f4f4f", "Wind Advisory": "#d2b48c", "Wind Warning": "#f3aa00",
  "Winter Storm Warning": "#ff69b4", "Winter Storm Watch": "#4682b4", "Winter Weather Advisory": "#7b68ee",
}
const UNKNOWN = "#e8e8e8"
/** The event's colour and the text colour (APCA) that reads on it. */
export function alertColor(event: string) {
  const bg = COLORS[event] ?? COLORS[event.replace(/^(Small Craft Advisory).*/, "$1")] ?? UNKNOWN
  return { bg, fg: contrastTextColor(bg) }
}
