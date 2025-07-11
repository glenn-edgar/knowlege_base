"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KBRpcServer = exports.NoMatchingRecordError = void 0;
const uuid_1 = require("uuid");
class NoMatchingRecordError extends Error {
}
exports.NoMatchingRecordError = NoMatchingRecordError;
class KBRpcServer {
    constructor(kbSearch, database) {
        this.maxBackoff = 8000;
        this.kbSearch = kbSearch;
        this.client = kbSearch.getConn();
        this.baseTable = `${database}_rpc_server`;
    }
    sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
    async findRpcServerId(kb, nodeName, properties, nodePath) {
        const results = await this.findRpcServerIds(kb, nodeName, properties, nodePath);
        if (results.length === 0) {
            throw new Error(`No node found matching path parameters: ${nodeName}, ${JSON.stringify(properties)}, ${nodePath}`);
        }
        if (results.length > 1) {
            throw new Error(`Multiple nodes found matching path parameters: ${nodeName}, ${JSON.stringify(properties)}, ${nodePath}`);
        }
        return results[0];
    }
    async findRpcServerIds(kb, nodeName, properties, nodePath) {
        this.kbSearch.clearFilters();
        this.kbSearch.searchLabel('KB_RPC_SERVER_FIELD');
        if (kb)
            this.kbSearch.searchKb(kb);
        if (nodeName)
            this.kbSearch.searchName(nodeName);
        if (properties) {
            for (const key of Object.keys(properties)) {
                this.kbSearch.searchPropertyValue(key, properties[key]);
            }
        }
        if (nodePath)
            this.kbSearch.searchPath(nodePath);
        const nodeIds = await this.kbSearch.executeQuery();
        if (!nodeIds || nodeIds.length === 0) {
            throw new Error(`No node found matching path parameters: ${nodeName}, ${JSON.stringify(properties)}, ${nodePath}`);
        }
        return nodeIds;
    }
    findRpcServerTableKeys(keyData) {
        return keyData.map(k => k.path);
    }
    async listJobsJobTypes(serverPath, state) {
        if (!this.isValidLtree(serverPath)) {
            throw new Error("serverPath must be a non-empty valid ltree string");
        }
        const allowed = new Set(['empty', 'new_job', 'processing']);
        if (!allowed.has(state)) {
            throw new Error(`state must be one of ${[...allowed].join(',')}`);
        }
        const query = `
      SELECT *
      FROM ${this.baseTable}
      WHERE server_path = $1::ltree AND state = $2
      ORDER BY priority DESC, request_timestamp ASC
    `;
        await this.client.query('BEGIN');
        try {
            const res = await this.client.query(query, [serverPath, state]);
            await this.client.query('COMMIT');
            return res.rows;
        }
        catch (err) {
            await this.client.query('ROLLBACK');
            throw new Error(`Database error in listJobsJobTypes: ${err.message}`);
        }
    }
    async countAllJobs(serverPath) {
        return {
            empty_jobs: await this.countEmptyJobs(serverPath),
            new_jobs: await this.countNewJobs(serverPath),
            processing_jobs: await this.countProcessingJobs(serverPath)
        };
    }
    countProcessingJobs(serverPath) {
        return this.countJobsJobTypes(serverPath, 'processing');
    }
    countNewJobs(serverPath) {
        return this.countJobsJobTypes(serverPath, 'new_job');
    }
    countEmptyJobs(serverPath) {
        return this.countJobsJobTypes(serverPath, 'empty');
    }
    async countJobsJobTypes(serverPath, state) {
        if (!this.isValidLtree(serverPath)) {
            throw new Error("serverPath must be valid ltree");
        }
        const valid = new Set(['empty', 'new_job', 'processing', 'completed_job']);
        if (!valid.has(state)) {
            throw new Error(`state must be one of ${[...valid].join(',')}`);
        }
        const query = `
      SELECT COUNT(*) AS job_count
      FROM ${this.baseTable}
      WHERE server_path = $1::ltree AND state = $2
    `;
        await this.client.query('BEGIN');
        try {
            const res = await this.client.query(query, [serverPath, state]);
            await this.client.query('COMMIT');
            return parseInt(res.rows[0].job_count, 10);
        }
        catch (err) {
            await this.client.query('ROLLBACK');
            throw new Error(`Database error in countJobsJobTypes: ${err.message}`);
        }
    }
    async pushRpcQueue(serverPath, requestId, rpcAction, requestPayload, transactionTag, priority = 0, rpcClientQueue = null, maxRetries = 5, waitTime = 500) {
        if (!this.isValidLtree(serverPath))
            throw new Error("invalid serverPath");
        let reqId = requestId || (0, uuid_1.v4)();
        try {
            reqId = String((0, uuid_1.v4)().match(/[-\w]+/));
        }
        catch { }
        ;
        if (!rpcAction)
            throw new Error("rpc_action must be non-empty");
        JSON.stringify(requestPayload); // will throw if not serializable
        if (!transactionTag)
            throw new Error("transaction_tag must be non-empty");
        if (rpcClientQueue && !this.isValidLtree(rpcClientQueue)) {
            throw new Error("rpc_client_queue must be valid ltree or null");
        }
        const tableRef = this.baseTable;
        let attempt = 0;
        let delay = waitTime;
        while (attempt < maxRetries) {
            await this.client.query('BEGIN');
            try {
                await this.client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
                const lockKey = this.hash(`${tableRef}:${serverPath}`);
                await this.client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
                const selectQ = `
          SELECT id FROM ${tableRef}
          WHERE state='empty'
          ORDER BY priority DESC, request_timestamp ASC
          LIMIT 1 FOR UPDATE
        `;
                const rec = await this.client.query(selectQ);
                if (rec.rows.length === 0) {
                    await this.client.query('ROLLBACK');
                    throw new NoMatchingRecordError('No matching record');
                }
                const recordId = rec.rows[0].id;
                const updQ = `
          UPDATE ${tableRef} SET
            server_path=$1, request_id=$2, rpc_action=$3,
            request_payload=$4, transaction_tag=$5, priority=$6,
            rpc_client_queue=$7, state='new_job',
            request_timestamp=NOW() AT TIME ZONE 'UTC', completed_timestamp=NULL
          WHERE id=$8 RETURNING *;
        `;
                const res = await this.client.query(updQ, [
                    serverPath,
                    reqId,
                    rpcAction,
                    JSON.stringify(requestPayload),
                    transactionTag,
                    priority,
                    rpcClientQueue,
                    recordId
                ]);
                await this.client.query('COMMIT');
                return res.rows[0];
            }
            catch (err) {
                await this.client.query('ROLLBACK');
                const retryable = err.code === '40001' || err.code === '40P01';
                attempt++;
                if (retryable && attempt < maxRetries) {
                    await this.sleep(delay);
                    delay = Math.min(delay * 2, this.maxBackoff);
                    continue;
                }
                if (err instanceof NoMatchingRecordError)
                    throw err;
                throw new Error(`Error in pushRpcQueue: ${err.message}`);
            }
        }
        throw new Error(`Failed after ${maxRetries} retries`);
    }
    isValidLtree(path) {
        if (!path)
            return false;
        const parts = path.split('.');
        return parts.every(p => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p));
    }
    async peakServerQueue(serverPath, retries = 5, waitTime = 1000) {
        let attempt = 0;
        while (attempt < retries) {
            await this.client.query('BEGIN');
            try {
                await this.client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
                const sel = `
          SELECT * FROM ${this.baseTable}
          WHERE server_path=$1 AND state='new_job'
          ORDER BY priority DESC, request_timestamp ASC
          LIMIT 1 FOR UPDATE SKIP LOCKED
        `;
                const res = await this.client.query(sel, [serverPath]);
                if (res.rows.length === 0) {
                    await this.client.query('ROLLBACK');
                    return null;
                }
                const row = res.rows[0];
                const upd = `
          UPDATE ${this.baseTable} SET state='processing', processing_timestamp=NOW() AT TIME ZONE 'UTC'
          WHERE id=$1 RETURNING id;
        `;
                const ures = await this.client.query(upd, [row.id]);
                if (ures.rows.length === 0) {
                    await this.client.query('ROLLBACK');
                    throw new Error(`Failed to update processing for id ${row.id}`);
                }
                await this.client.query('COMMIT');
                return row;
            }
            catch (err) {
                await this.client.query('ROLLBACK');
                attempt++;
                if (attempt < retries) {
                    await this.sleep(waitTime * 2 ** attempt);
                    continue;
                }
                throw new Error(`Error in peakServerQueue: ${err.message}`);
            }
        }
        return null;
    }
    async markJobCompletion(serverPath, id, retries = 5, waitTime = 1000) {
        let attempt = 0;
        while (attempt < retries) {
            await this.client.query('BEGIN');
            try {
                await this.client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
                const verify = `
          SELECT id FROM ${this.baseTable}
          WHERE id=$1 AND server_path=$2 AND state='processing' FOR UPDATE
        `;
                const vres = await this.client.query(verify, [id, serverPath]);
                if (vres.rows.length === 0) {
                    await this.client.query('ROLLBACK');
                    return false;
                }
                const upd = `
          UPDATE ${this.baseTable} SET state='empty', completed_timestamp=NOW() AT TIME ZONE 'UTC'
          WHERE id=$1 RETURNING id;
        `;
                await this.client.query(upd, [id]);
                await this.client.query('COMMIT');
                return true;
            }
            catch (err) {
                await this.client.query('ROLLBACK');
                attempt++;
                if (attempt < retries) {
                    await this.sleep(waitTime * 2 ** attempt);
                    continue;
                }
                throw new Error(`Error in markJobCompletion: ${err.message}`);
            }
        }
        return false;
    }
    async clearServerQueue(serverPath, maxRetries = 3, retryDelay = 1000) {
        let attempt = 0;
        const updateQ = `
      UPDATE ${this.baseTable}
      SET request_id = gen_random_uuid(),
          request_payload = '{}',
          completed_timestamp = CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
          state = 'empty',
          rpc_client_queue = NULL
      WHERE server_path = $1::ltree;
    `;
        while (attempt < maxRetries) {
            await this.client.query('BEGIN');
            try {
                const res = await this.client.query(updateQ, [serverPath]);
                await this.client.query('COMMIT');
                return res.rowCount ?? 0;
            }
            catch (err) {
                await this.client.query('ROLLBACK');
                attempt++;
                if (attempt < maxRetries) {
                    await this.sleep(retryDelay);
                    continue;
                }
                throw new Error(`Failed to clear server queue: ${err.message}`);
            }
        }
        return 0;
    }
    // Simple string hash to 32-bit int
    hash(s) {
        let h = 0;
        for (const ch of s) {
            h = ((h << 5) - h) + ch.charCodeAt(0);
            h |= 0;
        }
        return h;
    }
}
exports.KBRpcServer = KBRpcServer;
