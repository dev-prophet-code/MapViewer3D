// The read-only SQL the sandbox edition sends through the console's addon bridge (database.query).
//
// Inside the Console the addon page has no network at all (CSP connect-src 'none', sandboxed iframe):
// the only way to data is the bridge. The map data comes straight from the game database, with the
// same queries the Console's own Live Map uses (Red-Blink/dune-awakening-selfhost-docker,
// console/api/src/duneDb.js, MIT licence), reduced to what the 3D viewer draws.
//
// Rules for everything in this file:
//  * only SELECTs; the console additionally runs them in a read-only transaction,
//  * no parameters exist on the bridge: values are validated here and written into the text,
//  * the console refuses a query that merely CONTAINS one of insert/update/delete/drop/alter/
//    truncate/create/grant/revoke as a word (tests/sandbox-sql.mjs runs its guard over every query),
//    so none of these words appears anywhere, not even in a comment,
//  * the bridge is limited to 60 calls a minute: one query returns everything a refresh needs.

export const SOURCES = { Survival_1: 'Hagga Basin', DeepDesert_1: 'Deep Desert' };

const MAP = /^[A-Za-z0-9_]{1,64}$/;
const INT = /^[0-9]{1,12}$/;

export function mapLiteral(source) {
  if (!MAP.test(String(source))) throw new Error('invalid map name');
  return `'${source}'`;
}

export function intLiteral(value) {
  if (!INT.test(String(value))) throw new Error('invalid number');
  return String(value);
}

const PERMISSION_OWNER_RANK = 1;

const BASE_NAME = `case
  when nullif(btrim(pa.actor_name), '') is not null
    and lower(btrim(pa.actor_name)) <> 'none'
    and btrim(pa.actor_name) not like '##%'
  then btrim(pa.actor_name)
  when lower(coalesce(a.class, '')) like '%totemsmall%' then 'Totem_Small_Patent'
  when lower(coalesce(a.class, '')) like '%totem%' then 'Totem_Patent'
  else 'Unnamed Base'
end`;

const BASE_TYPE = `case
  when lower(coalesce(a.class, '')) like '%totemsmall%' then 'Sub-Fief'
  when lower(coalesce(a.class, '')) like '%totem%' then 'Advanced Sub-Fief'
  else 'Unknown'
end`;

// An actor only counts when its partition has a running server (as in the Console).
const livePartition = (alias) => `coalesce(${alias}.partition_id, 0) > 0 and exists (select 1 from dune.world_partition wp where wp.partition_id = ${alias}.partition_id and nullif(wp.server_id, '') is not null)`;

const xyz = (expr) => `((${expr}).location).x as x, ((${expr}).location).y as y, ((${expr}).location).z as z`;

// Everything that moves or is built, for one map, as ONE row of json columns.
// vehicleState: false for databases that have no state column on the actors (older game versions).
export function snapshotSql(source, { vehicleState = true } = {}) {
  const map = mapLiteral(source);
  return `select
  (select coalesce(json_agg(r), '[]'::json) from (
    select a.id::text as id, 'player' as type,
           coalesce(nullif(ps.character_name, ''), 'Unknown') as name,
           coalesce(ps.online_status::text, '') as online_status,
           coalesce(a.map, '') as map, coalesce(a.partition_id, 0) as partition_id, coalesce(a.class, '') as class,
           ${xyz('a.transform')}
    from dune.actors a
    join dune.player_state ps on ps.player_pawn_id = a.id
    where a.transform is not null and a.map = ${map} and ${livePartition('a')}
    order by coalesce(ps.online_status::text, '') desc, lower(coalesce(ps.character_name, ''))
  ) r) as players,
  (select coalesce(json_agg(r), '[]'::json) from (
    select a.id::text as id, 'vehicle' as type, coalesce(a.class, '') as name,
           coalesce(a.map, '') as map, coalesce(a.partition_id, 0) as partition_id, coalesce(a.class, '') as class,
           coalesce(owner.character_name, '') as owner_name,
           ${xyz('a.transform')}
    from dune.vehicles v
    join dune.actors a on a.id = v.id
    left join lateral (
      select ps.character_name
      from dune.permission_actor_rank par
      join dune.actors player_a on player_a.id = par.player_id
      join dune.player_state ps on ps.account_id = player_a.owner_account_id
      where par.permission_actor_id = a.id and par.rank = ${PERMISSION_OWNER_RANK}
      order by ps.character_name
      limit 1
    ) owner on true
    where a.transform is not null and a.map = ${map} and ${livePartition('a')}
${vehicleState ? "\n      and coalesce(a.state::text, 'Default') not in ('Travel', 'VehicleBackup', 'VehicleRecovery')" : ''}
    order by a.partition_id, a.id
  ) r) as vehicles,
  (select coalesce(json_agg(r), '[]'::json) from (
    select min(b.id)::text as id, 'base' as type,
           ${BASE_NAME} as name, ${BASE_TYPE} as base_type,
           coalesce(owner.character_name, '') as owner_name,
           coalesce(a.map, '') as map, coalesce(a.partition_id, 0) as partition_id, coalesce(a.class, '') as class,
           ${xyz('a.transform')}
    from dune.buildings b
    join dune.building_instances bi on bi.building_id = b.id
    join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
    join dune.actors a on a.id = afe.actor_id
    left join dune.permission_actor pa on pa.actor_id = a.id
    left join lateral (
      select ps.character_name
      from dune.permission_actor_rank par
      join dune.actors player_a on player_a.id = par.player_id
      join dune.player_state ps on ps.account_id = player_a.owner_account_id
      where par.permission_actor_id = a.id
      order by par.rank asc, ps.character_name asc
      limit 1
    ) owner on true
    where a.transform is not null and a.map = ${map} and ${livePartition('a')}
      and not (pa.actor_id is null and exists (select 1 from dune.base_backup_linked_actors backup_link where backup_link.actor_id = a.id))
    group by pa.actor_name, owner.character_name, a.id, a.map, a.partition_id, a.class, a.transform
    order by a.partition_id, min(b.id)
  ) r) as bases,
  (select coalesce(json_agg(r), '[]'::json) from (
    select p.id::text as id, 'storage' as type,
           coalesce(max(case when pa.actor_name not like '##%' and pa.actor_name <> 'None' then pa.actor_name end), p.building_type) as name,
           coalesce(a.map, '') as map, coalesce(a.partition_id, 0) as partition_id, p.building_type as class,
           count(i.id)::int as item_count,
           ${xyz('a.transform')}
    from dune.placeables p
    join dune.actors a on a.id = p.id
    left join dune.permission_actor pa on pa.actor_id = p.id
    left join dune.inventories inv on inv.actor_id = p.id
    left join dune.items i on i.inventory_id = inv.id
    where p.building_type in ('SpiceSilo_Placeable', 'GenericContainer_Placeable', 'StorageContainer_Placeable', 'MediumStorageContainer_Placeable', 'Developer_StorageContainer_Placeable')
      and a.transform is not null and a.map = ${map} and ${livePartition('a')}
    group by p.id, p.building_type, a.map, a.partition_id, a.transform
    order by a.partition_id, p.id
  ) r) as storage`;
}

// The instances of the game (Hagga Basin, Deep Desert, ...) with a server, and whether it runs.
export function partitionsSql() {
  return `select wp.partition_id::int as partition_id,
       case lower(wp.map) when 'deepdesert_1' then 'DeepDesert' when 'survival_1' then 'HaggaBasin' else wp.map end as map,
       coalesce(nullif(wp.label, ''), nullif(wp.map, ''), 'Partition ' || wp.partition_id::text) as name,
       coalesce(bool_or(fs.alive), false) as alive
from dune.world_partition wp
left join dune.farm_state fs on fs.server_id = wp.server_id
where wp.partition_id > 0 and lower(wp.map) in ('deepdesert_1', 'survival_1')
group by wp.partition_id, wp.map, wp.label
order by wp.map, wp.partition_id`;
}

// Markers (points of interest and resources) as the Console's Live Map groups them.
export const POI_CATEGORIES = {
  ore: ['%Ore', '%Pickup', '%Rock'],
  scrap: ['%scrap%', '%fuelcell%'],
  flora: ['%bush%', '%primrose%', '%saguaro%'],
  hazard: ['%hazard%'],
  enemy: ['EnemyCamp', 'EnemyLaborOutpost', 'EnemyOutpost'],
  fortress: ['%fortress%'],
  house_representative: ['%houserepresentative%'],
  trainer: ['%trainer%'],
  poi: ['%cave%', '%ecolab%', '%sietch%', '%dojo%', '%vendor%', '%choam%', '%bank%', '%tradingpost%', '%taxi%', '%imperialconsulate%', '%shipwreck%'],
};

export function poiSql(source) {
  const map = mapLiteral(source);
  const values = Object.entries(POI_CATEGORIES)
    .map(([key, patterns]) => `('${key}', array[${patterns.map((p) => `'${p}'`).join(', ')}])`)
    .join(', ');
  return `select m.marker_hash_id::text as id, c.cat as category, m.marker_type as marker_type,
       (m.position).x as x, (m.position).y as y, (m.position).z as z
from dune.markers m
join dune.map_names mn on mn.map_name_id = m.map_name_id
join (values ${values}) as c(cat, pats) on m.marker_type ilike any(c.pats)
where m.marker_type not ilike 'NoIcon' and mn.map_name = ${map}
order by m.marker_hash_id`;
}

// One base with all its pieces and placeables, in ONE row (the viewer builds the 3D buildings from it).
// Positions are relative to the base's own anchor, rotation is the yaw only, exactly as the Console exports it.
export function baseExportSql(id) {
  const baseId = intLiteral(id);
  return `with target_claim as (
  select distinct a.id as actor_id
  from dune.buildings b
  join dune.building_instances requested_bi on requested_bi.building_id = b.id
  join dune.actor_fgl_entities requested_afe on requested_afe.entity_id = requested_bi.owner_entity_id
  join dune.actors a on a.id = requested_afe.actor_id
  where b.id = ${baseId}
), base as (
  select min(b.id)::text as base_id, ${BASE_NAME} as name, ${BASE_TYPE} as base_type,
         coalesce(a.map, '') as map, a.id as actor_id,
         ${xyz('a.transform')}
  from target_claim tc
  join dune.actors a on a.id = tc.actor_id
  join dune.actor_fgl_entities afe on afe.actor_id = a.id
  join dune.building_instances bi on bi.owner_entity_id = afe.entity_id
  join dune.buildings b on b.id = bi.building_id
  left join dune.permission_actor pa on pa.actor_id = a.id
  group by pa.actor_name, a.id, a.class, a.map, a.transform
)
select base.base_id, base.name, base.base_type, base.map, base.x, base.y, base.z,
  (select coalesce(json_agg(r), '[]'::json) from (
    select bi.building_type, bi.transform[1] - base.x as x, bi.transform[2] - base.y as y, bi.transform[3] - base.z as z,
           bi.transform[6] as qz, bi.transform[7] as qw
    from dune.building_instances bi
    join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
    where afe.actor_id = base.actor_id
    order by bi.building_id, bi.instance_id
  ) r) as instances,
  (select coalesce(json_agg(r), '[]'::json) from (
    select p.building_type,
           ((a.transform).location).x - base.x as x, ((a.transform).location).y - base.y as y, ((a.transform).location).z - base.z as z,
           ((a.transform).rotation).z as qz, ((a.transform).rotation).w as qw
    from dune.placeables p
    join dune.actors a on a.id = p.id
    join dune.actor_fgl_entities afe on afe.entity_id = p.owner_entity_id
    where afe.actor_id = base.actor_id and a.transform is not null
      and lower(coalesce(p.building_type, '')) not in ('totem_small_placeable', 'totem_placeable')
    order by p.id
  ) r) as placeables
from base`;
}

// ---- shaping the answers like the Console's REST routes (what the viewer already understands) ----

const VEHICLE_SUBTYPES = [
  [/sandbike/i, 'Sandbike'], [/buggy/i, 'Buggy'], [/sandcrawler/i, 'SandCrawler'], [/treadwheel/i, 'TreadWheel'],
  [/container/i, 'ContainerVehicle'], [/tank/i, 'Tank'],
  [/assault.*ornithopter|ornithopter.*assault/i, 'AssaultOrnithopter'], [/light.*ornithopter|ornithopter.*light/i, 'LightOrnithopter'],
  [/medium.*ornithopter|ornithopter.*medium/i, 'MediumOrnithopter'], [/transport.*ornithopter|ornithopter.*transport/i, 'TransportOrnithopter'],
  [/ornithopter/i, 'Ornithopter'],
];

export function vehicleSubtype(cls) {
  for (const [re, name] of VEHICLE_SUBTYPES) if (re.test(String(cls ?? ''))) return name;
  return 'Other';
}

// The Deep Desert's 9x9 sector grid (measured in game, same constants as the Console).
export function deepDesertSector(x, y) {
  const col = Math.floor((x + 1268450) / 269650);
  const row = Math.floor((1163467 - y) / 269217);
  if (!(col >= 0 && col < 9 && row >= 0 && row < 9)) return null;
  return `${String.fromCharCode(65 + row)}${col + 1}`;
}

const withSector = (row) => (/^deepdesert/i.test(String(row.map).replace(/[\s_-]/g, '')) ? { ...row, sector: deepDesertSector(row.x, row.y) } : row);
const num = (v) => Number(v);
const point = (r) => ({ ...r, x: num(r.x), y: num(r.y), z: num(r.z), partition_id: num(r.partition_id) });

export function shapeSnapshot(row) {
  return {
    players: (row.players ?? []).map((r) => withSector(point(r))),
    overlays: [
      ...(row.vehicles ?? []).map((r) => withSector({ ...point(r), subtype: vehicleSubtype(r.class) })),
      ...(row.bases ?? []).map((r) => withSector(point(r))),
      ...(row.storage ?? []).map((r) => withSector(point(r))),
    ],
  };
}

const ORE_NAMES = { Azurite: 'Copper', Basalt: 'Basalt', Bauxite: 'Aluminium', Dolomite: 'Carbon', Erythrite: 'Erythrite', Jasmium: 'Jasmium', Magnetite: 'Iron', Rhyolite: 'Granite', Stravidium: 'Stravidium', Titanium: 'Titanium' };

export function subtypeLabel(category, subtype) {
  if (category !== 'ore') return subtype;
  const material = String(subtype).replace(/(Ore|Pickup|Rock)$/, '');
  return ORE_NAMES[material] || material || subtype;
}

export function shapePoi(rows, source) {
  return rows.map((r) => withSector({
    id: r.id, type: r.category, name: r.marker_type, subtype: r.marker_type, subtypeLabel: subtypeLabel(r.category, r.marker_type),
    map: source, x: num(r.x), y: num(r.y), z: num(r.z),
  }));
}

// The yaw (rotation about the vertical axis, degrees) of a quaternion given as z and w: the Console's formula.
export function yawDegrees(qz, qw) {
  return (2 * Math.atan2(Number(qz) || 0, Number(qw) || 0)) * (180 / Math.PI);
}

export function shapeBaseExport(row) {
  return {
    base_id: row.base_id, name: row.name, base_type: row.base_type, map: row.map, x: num(row.x), y: num(row.y), z: num(row.z),
    instances: (row.instances ?? []).map((p) => ({ building_type: p.building_type, x: num(p.x) || 0, y: num(p.y) || 0, z: num(p.z) || 0, rotation: yawDegrees(p.qz, p.qw) })),
    placeables: (row.placeables ?? []).map((p) => ({ building_type: p.building_type, x: num(p.x), y: num(p.y), z: num(p.z), rx: 0, ry: yawDegrees(p.qz, p.qw), rz: 0 })),
  };
}
