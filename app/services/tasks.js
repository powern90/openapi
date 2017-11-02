const EventEmitter = require('events');
const Memcached = require('memcached');
const schedule = require('node-schedule');
const Config = require('../config');
const CustomError = require('./custom-error');
const Item = require('../models/item');

// Scan 200 items per every 0.5 second whenever queued items are less than (1000 - 200)
const MAX_QUEUE_SIZE = 1000;
const SCAN_SIZE = 200;
const SCAN_INTERVAL_MSEC = 500;


// DataSource interface
class DataSource {
	isEmpty() { return true; }

	get(size) {
		return Promise.resolve([]);
	}
}


// ItemModelDataSource class
class ItemModelDataSource extends DataSource {
	constructor() {
		super();
		this._idScanFrom = null;
		this._finished = false;
	}

	isEmpty() {
		return this._finished;
	}

	get(size) {
		const fromId = this._idScanFrom;

		return Item.scan(size, fromId)
		.then((result) => {
			// Verify count of items
			if (result.count !== result.items.length) {
				throw new CustomError.ServerError(`not matching fetched items count`, 'DataSourceError');
			}

			// Mark finished if final flag is set
			if (result.final) {
				this._finished = true;
			}
			// Otherwise save the ID of the beginning of next scan
			else {
				if (!result.nextId) {
					throw new CustomError.ServerError(`missing 'nextId' value in scan result`, 'DataSourceError');
				}
				this._idScanFrom = result.nextId;
			}

			return result.items;
		});
	}
}


// TaskManager class - Handle fetching and consuming of items
class TaskManager extends EventEmitter {
	constructor() {
		super();

		// Register event listeners for synchronization
		this.on('fetch', this._fetch);
		this.on('consume', this._consume);

		// Private variables
		this._tFetchItems = null;    // Timer object for fetching tasks
		this._event = {
			started: null,
			finished: null,
			exhausted: null,
			scheduled: null
		};
		this._count = {
			fetched: 0,
			consumed: 0
		};
		this._itemQueue = [];
		this._idScanFrom = null;

		// Scheduling (cron-based) - Default schedule is 'AT EVERY HOUR ON THE HOUR'
		const scheduleHandler = this._wakeup.bind(this);
		this._scheduledJob = schedule.scheduleJob('00 * * * *', scheduleHandler);
	}

	get startedAt()     { return this._event.started; }
	get finishedAt()    { return this._event.finished; }
	get exhaustedAt()   { return this._event.exhausted; }
	get scheduledAt()   { return this._event.scheduled; }
	get fetched()       { return this._count.fetched; }
	get consumed()      { return this._count.consumed; }
	get available()     { return this._itemQueue.length; }

	isBusy() {
		return (this._tFetchItems || this.available);
	}

	forceTrigger(dataSource) {
		if (this.isBusy()) return;  // Do nothing if it is already running

		//this._scheduledJob.cancelNext(true);          // TODO: Not working as expected
		//this._scheduledJob.reschedule('00 * * * *');
		this._wakeup(dataSource);
	}

	popTasks(size = 1) {
		return new Promise((resolve, reject) => {
			const haveListeners = this.emit('consume', size, resolve);
			if (!haveListeners) {
				reject(new CustomError.ServerError(`no handler for 'consume' event`, 'TaskManagerError'));
			}
		});
	}


	///////////////////////////////////////////////////////////////////////////
	// Private methods

	_wakeup(dataSource = new ItemModelDataSource()) {
		// Prevent two or more jobs working simultaneously
		if (this.isBusy()) return;

		// Initialize
		this._event = {
			started: new Date(),    // Mark as started
			finished: null,
			exhausted: null,
			scheduled: this._scheduledJob.nextInvocation()
		};
		this._count = {
			fetched: 0,
			consumed: 0
		};
		this._itemQueue = [];
		this._idScanFrom = null;

		// Enable fetch task
		this._tFetchItems = setInterval(() => {
			// Enough amount of items are already in queue
			if (this.available > (MAX_QUEUE_SIZE - SCAN_SIZE)) return;

			dataSource.get(SCAN_SIZE)
			.then((items) => {
				// Emit 'fetch' event - TaskManager._fetch() will be invoked
				const haveListeners = this.emit('fetch', items);
				if (!haveListeners) {
					throw new CustomError.ServerError(`no handler for 'fetch' event`, 'TaskManagerError');
				}

				// Suspend fetch task if no more items are left
				if (dataSource.isEmpty()) {
					this._suspend();
				}
			});
		}, SCAN_INTERVAL_MSEC);
	}

	_suspend() {
		this._event.finished = new Date();  // Mark as finished

		// Disable fetch task
		clearInterval(this._tFetchItems);
		this._tFetchItems = null;
	}

	_fetch(items) {
		this._itemQueue = this._itemQueue.concat(items);
		this._count.fetched += items.length;
	}

	_consume(size, resolve) {
		const itemsToConsume = this._itemQueue.splice(0, size);
		this._count.consumed += itemsToConsume.length;

		if (this._event.finished && !this._event.exhausted && !this._itemQueue.length) {
			this._event.exhausted = new Date();  // Mark as consumed
		}

		resolve(itemsToConsume);
	}
}


// TaskService - Facade of TaskManager
class TaskService {
	constructor() {
		this._manager = new TaskManager();

		const memcachedServer = `${Config['server']}:11211`;
		this._memcached = new Memcached(memcachedServer, {retries: 1});
	}

	requestTasks(agent, size = 1) {
		if (!agent) {
			const err = new CustomError.InvalidArgument('missing required parameter (agent)');
			return Promise.reject(err);
		}

		return this._manager.popTasks(size)
		.then((items) => {
			return items.map((item) => {
				const id = item.get('id');
				const mid = (id.split('_')[1] || '');
				return {id, mid};
			});
		});
	}

	getStatsSync(agent) {
		const {startedAt, finishedAt, exhaustedAt, scheduledAt} = this._manager;
		const {fetched, consumed, available} = this._manager;
		const elapsedTime = (start, end) => {
			return (start ? (end || new Date()) - start : 0);
		};

		const now = new Date();
		const msecTotalElapsed = elapsedTime(startedAt, now);
		const msecFetchElapsed = elapsedTime(startedAt, finishedAt);
		const msecConsumeElapsed = elapsedTime(startedAt, exhaustedAt);

		return {
			status: this._manager.isBusy() ? 'running' : 'idle',
			current_event: {
				started: startedAt,
				finished: finishedAt,
				exhausted: exhaustedAt,
				elapsed: TaskService._msToString(msecTotalElapsed)
			},
			next_event: scheduledAt,
			count: {
				fetched,
				consumed,
				available
			},
			throughput: {
				fetch: TaskService._throughput(fetched, msecFetchElapsed),
				consume: TaskService._throughput(consumed, msecConsumeElapsed)
			}
		};
	}

	getStatsAsync(agent) {
		return new Promise((resolve) => {
			resolve(this.getStatsSync(agent));
		});
	}

	getClientVersion() {
		return new Promise((resolve, reject) => {
			this._memcached.get('clientVersion', (err, data = 1) => {
				if (err) reject(new CustomError.ServerError(err.message, err.name));
				else resolve(data);
			});
		});
	}

	setClientVersion(version) {
		if (!version) {
			throw new CustomError.InvalidArgument('missing required parameter (version)');
		}
		const expired = 0;  // Never expired

		return new Promise((resolve, reject) => {
			this._memcached.set('clientVersion', version, expired, (err) => {
				if (err) reject(new CustomError.ServerError(err.message, err.name));
				else resolve();
			});
		});
	}

	static _msToString(time) {
		const pad = (num, space = 2) => {
			let padded = String(num);
			while (padded.length < space) padded = '0' + padded;
			return padded;
		};

		const ms = time % 1000;
		time = (time - ms) / 1000;
		const s = time % 60;
		time = (time - s) / 60;
		const m = time % 60;
		time = (time - m) / 60;
		const h = time;

		return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
	}

	static _throughput(count, msec) {
		const throughput = (msec ? Math.round(count / msec * 1000 * 100) / 100 : 0);
		return `${throughput} processed/sec`;
	}
}


module.exports = new TaskService();


// FOR TEST PURPOSE
/*
class DummyDataSource extends DataSource {
	constructor() {
		super();

		// Initialize dummy items
		this._items = [];
		for (let i = 1000; i < 3000; ++i) {
			this._items.push({
				id: String(i),
				name: `Item_${i}`
			});
		}
	}

	isEmpty() {
		return (this._items.length === 0);
	}

	get(size) {
		const items = this._items.splice(0, size);
		return Promise.resolve(items);
	}
}

class TaskServiceTester {
	static launch() {
		// Start producer
		const taskService = new TaskService();
		taskService._manager.forceTrigger(new DummyDataSource());

		// Start 5 consumers
		const requestTasks = (agent) => {
			return setInterval(() => {
				taskService.requestTasks(agent, 12)
				.then((items) => {
					const stats = taskService.getStatsSync(null);
					console.log(`---------------------------------------------`);
					console.log(`${JSON.stringify(stats, null, 4)}`);
				});
			}, 200);
		};
		const tasks = [1, 2, 3, 4, 5].map((num) => {
			return requestTasks(`agent${num}`);
		});

		setTimeout(() => {
			tasks.forEach(clearInterval);
		}, 10000);
	}
}

TaskServiceTester.launch();
*/
