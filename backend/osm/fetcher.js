/**
 * VEIL — OpenStreetMap Overpass API Fetcher
 *
 * Fetches real Points of Interest from OpenStreetMap for Bengaluru.
 * Uses the Overpass API with QL (Overpass Query Language) to pull
 * nodes tagged as hospitals, restaurants, pharmacies, or cafes within
 * a bounding box around central Bengaluru.
 *
 * Data structure returned per POI:
 *   { id, name, category, latitude, longitude, tags }
 */

import fetch from "node-fetch";

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

// Bengaluru bounding box: south, west, north, east
// Covers roughly a 20 km radius around central Bengaluru (Majestic area)
const BENGALURU_BBOX = {
  south: 12.8,
  west: 77.45,
  north: 13.1,
  east: 77.75,
};

/**
 * Category tag mappings for Overpass QL.
 * Each category maps to one or more OpenStreetMap amenity/tag values.
 */
export const CATEGORY_TAGS = {
  hospital: `["amenity"~"hospital|clinic|doctors"]`,
  restaurant: `["amenity"="restaurant"]`,
  pharmacy: `["amenity"="pharmacy"]`,
  cafe: `["amenity"="cafe"]`,
  atm: `["amenity"="atm"]`,
  school: `["amenity"~"school|university|college"]`,
  park: `["leisure"="park"]`,
  supermarket: `["shop"~"supermarket|convenience"]`,
};

/**
 * Build the Overpass QL query for a set of categories within a bounding box.
 *
 * Query structure:
 *   [out:json][timeout:30];
 *   (
 *     node["amenity"="restaurant"](bbox);
 *     node["amenity"~"hospital|clinic"](bbox);
 *     ...
 *   );
 *   out body;
 *
 * @param {string[]} categories  - Array of category keys from CATEGORY_TAGS
 * @param {object}   bbox        - { south, west, north, east }
 * @returns {string}             - Overpass QL query string
 */
function buildOverpassQuery(categories, bbox) {
  const { south, west, north, east } = bbox;
  const bboxStr = `${south},${west},${north},${east}`;

  const tagFilters = categories
    .map((cat) => {
      const tagExpr = CATEGORY_TAGS[cat] || `["amenity"="${cat}"]`;
      return `node${tagExpr}(${bboxStr});`;
    })
    .join("\n    ");

  return `
[out:json][timeout:30];
(
    ${tagFilters}
);
out body;
`.trim();
}

/**
 * Normalise a raw OSM node element into a clean POI object.
 *
 * @param {object} node     - Raw OSM element
 * @param {string} category - Which category bucket this node belongs to
 * @returns {object}        - Normalised POI
 */
function normaliseNode(node, category) {
  const tags = node.tags || {};
  return {
    id: `osm_${node.id}`,
    osmId: node.id,
    name: tags.name || tags["name:en"] || tags.brand || `${category} ${node.id}`,
    category,
    latitude: node.lat,
    longitude: node.lon,
    tags: {
      phone: tags.phone || tags["contact:phone"] || null,
      website: tags.website || tags["contact:website"] || null,
      openingHours: tags.opening_hours || null,
      address: [
        tags["addr:housenumber"],
        tags["addr:street"],
        tags["addr:suburb"] || tags["addr:city"],
      ]
        .filter(Boolean)
        .join(", ") || null,
      cuisine: tags.cuisine || null,
      operator: tags.operator || null,
      emergency: tags.emergency || null,
      wheelchair: tags.wheelchair || null,
    },
  };
}

/**
 * Determine which category a node belongs to, given the tag-to-category mapping.
 * Nodes that match multiple filters are assigned the first matching category.
 *
 * @param {object}   node       - Raw OSM node
 * @param {string[]} categories - Requested categories
 * @returns {string}            - Assigned category string
 */
function detectCategory(node, categories) {
  const amenity = node.tags?.amenity || "";
  const leisure = node.tags?.leisure || "";
  const shop = node.tags?.shop || "";

  for (const cat of categories) {
    switch (cat) {
      case "hospital":
        if (/hospital|clinic|doctors/.test(amenity)) return "hospital";
        break;
      case "restaurant":
        if (amenity === "restaurant") return "restaurant";
        break;
      case "pharmacy":
        if (amenity === "pharmacy") return "pharmacy";
        break;
      case "cafe":
        if (amenity === "cafe") return "cafe";
        break;
      case "atm":
        if (amenity === "atm") return "atm";
        break;
      case "school":
        if (/school|university|college/.test(amenity)) return "school";
        break;
      case "park":
        if (leisure === "park") return "park";
        break;
      case "supermarket":
        if (/supermarket|convenience/.test(shop)) return "supermarket";
        break;
      default:
        if (amenity === cat) return cat;
    }
  }
  return categories[0]; // fallback
}

/**
 * Fetch POIs from the Overpass API with retry logic.
 *
 * @param {string[]} categories   - Which categories to fetch
 * @param {object}   [bbox]       - Custom bounding box (default: Bengaluru)
 * @param {number}   [maxResults] - Cap total returned POIs (default: 500)
 * @returns {Promise<object[]>}   - Array of normalised POI objects
 */
export async function fetchPOIs(
  categories = ["hospital", "restaurant", "pharmacy", "cafe"],
  bbox = BENGALURU_BBOX,
  maxResults = 500
) {
  const query = buildOverpassQuery(categories, bbox);

  console.log(
    `[OSM] Fetching ${categories.join(", ")} POIs in bbox`,
    bbox
  );
  console.log(`[OSM] Query:\n${query}`);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(OVERPASS_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "VEIL-kNN-Project/1.0",
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(35_000),
      });

      if (!response.ok) {
        throw new Error(`Overpass returned HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!data.elements || !Array.isArray(data.elements)) {
        throw new Error("Overpass response missing elements array");
      }

      console.log(`[OSM] Raw elements from Overpass: ${data.elements.length}`);

      // Normalise and assign categories, then deduplicate by OSM id
      const seen = new Set();
      const pois = [];
      for (const el of data.elements) {
        if (el.type !== "node") continue;
        if (seen.has(el.id)) continue;
        seen.add(el.id);

        const cat = detectCategory(el, categories);
        pois.push(normaliseNode(el, cat));

        if (pois.length >= maxResults) break;
      }

      console.log(
        `[OSM] Normalised POIs: ${pois.length}`,
        pois.reduce((acc, p) => {
          acc[p.category] = (acc[p.category] || 0) + 1;
          return acc;
        }, {})
      );

      return pois;
    } catch (err) {
      lastError = err;
      console.warn(`[OSM] Attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
  }

  throw new Error(`Failed to fetch POIs after 3 attempts: ${lastError.message}`);
}

/**
 * Fetch POIs and return them grouped by category.
 *
 * @param {string[]} categories
 * @param {object}   [bbox]
 * @returns {Promise<object>}  - { hospital: [...], restaurant: [...], ... }
 */
export async function fetchPOIsByCategory(
  categories = ["hospital", "restaurant", "pharmacy", "cafe"],
  bbox = BENGALURU_BBOX
) {
  const pois = await fetchPOIs(categories, bbox);
  const grouped = {};
  for (const cat of categories) {
    grouped[cat] = pois.filter((p) => p.category === cat);
  }
  return grouped;
}

export { BENGALURU_BBOX };
