// adapters/index.ts — importing this registers every built adapter into ADAPTER_REGISTRY.
import './sqlite/canonical-store.ts';
import './sqlite/object-index.ts';
import './sqlite/work-queue.ts';
import './file/stream.ts';
import './fs/blob-cas.ts';
import './fs/audit-log.ts';
import './fs/lineage.ts';
import './gitfs/registry.ts';
import './internal/policy-identity.ts';
// richer engines (still zero-service): broker uses node:net; the rest are sqlite/memory/file
import './broker/stream.ts';
import './memory/cache.ts';
import './file/vector.ts';
import './sqlite/graph.ts';
import './sqlite/analytics-olap.ts';
import './sqlite/timeseries-geo.ts';
