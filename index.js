const utils = require('@satellite-earth/utils');
const Torrent = require('@satellite-earth/torrent');
const Signal = require('@satellite-earth/signal');
const Parcel = require('@satellite-earth/parcel');
const State = require('@satellite-earth/state');


class Epoch extends Torrent {

	constructor (payload) {

		super(payload);

		if (typeof this._signed_.name === 'undefined' || this._signed_.name.length === 0) {
			throw Error('Must sign \'name\' (matches epoch signer alias)');
		}

		if (typeof this.alpha === 'undefined') {
			throw Error('Must sign \'alpha\' (starting block number)');
		}

		if (typeof this.number === 'undefined') {
			throw Error('Must sign \'number\' (ordinal epoch number)');
		}

		if (this.number === 0 && this._signed_.ancestor) {
			throw Error('Genesis epoch must not have an ancestor');
		}

		if (typeof this.ancestor === 'undefined') {
			throw Error('Must sign \'ancestor\' (previous epoch uuid)');
		}

		// Meta data for signals in this epoch
		this.included = {};

		// States self-generate by responding to received signals
		// in accordance with logic contained in state's nucleus
		this.state = {};
	}

	// Inflate epoch with compressed data
	data (data, getInitialData) {

		return new Promise(async (resolve, reject) => {

			if (!(data instanceof Uint8Array || Buffer.isBuffer(data))) {
				reject(Error('Expected compressed epoch data as a Uint8Array or Buffer'));
			}

			// Decompress the epoch's data
			const parcel = new Parcel(data);
			const unpacked = parcel.unpacked;
			const signals = [];

			// Get the set of block numbers signed by at least one signal
			const range = Object.keys(unpacked.signals.clock).map(key => {
				return parseInt(key);
			}).sort((a, b) => {
				return a - b;
			});
			
			// Unpack signals array and assign location params
			for (let blockNumber of range) {

				for (let item of unpacked.signals.block[blockNumber]) {

					const _signed_ = item[0];
					let namespace;
					let action;
					let sender;
					let alias;
					let sig;

					if (item.length > 3) { // Aliased

						action = item[2];
						sig = item[3];

						const _a = item[1].split('.');
						sender = utils.hexToUtf8('0x' + _a[0]);
						alias = _a[0];
						
						if (typeof _a[1] !== 'undefined') {
							namespace = utils.hexToUtf8('0x' + _a[1]);
						}

					} else { // Anonymous

						action = item[1];
						sig = item[2];
					}
					
					const signal = new Signal({
						_signed_,
						_params_: {
							blockNumber,
							timestamp: unpacked.signals.clock[blockNumber][1],
							alias,
							sig
						}
					}, {
						action,
						sender,
						namespace,
						world: this.name,
						epoch: this.ancestor,
						block: unpacked.signals.clock[blockNumber][0]
					});

					signals.push(signal);
				}
			}

			// Add each initial state and each signal to epoch
			await this.build({ initial: unpacked.initial, signals }, getInitialData);

			// Calculate or verify data params
			return super.data(data).then(() => {
				resolve(this);
			}).catch(err => {
				reject(err);
			});
		});
	}

	// Include a verified signal, giving each state a chance
	// to update itself according to the data in the signal.
	// States will automatically ignore attempts to run an
	// update with a signal that has already been applied.
	include (signal) {

		// Context in which signal will be interpreted
		const context = {
			number: this.number,
			signer: this.name,
			alpha: this.alpha
		};

		// Compute the signer address so it will
		// be available to state's set funciton
		signal.address();

		// If signal is attempting to create or mutate a state
		if (signal.action === 'evolve') {

			// Only the epoch signer can mutate state's code
			if (signal.authorAlias !== this.name) {
				throw Error('State update logic can only be modified by the epoch signer');
			}

			// For each of the states whose logic the signal would modify
			for (let stateName of Object.keys(JSON.parse(signal._signed_.evolve))) {

				// If a state by this name does not exist, create one
				if (!this.state[stateName]) {
					this.state[stateName] = new State({
						established: signal.blockNumber,
						name: stateName
					});
				}

				// If the state was created by this signal, execute the
				// signal's code to initialize the store for the first
				// time. Otherwise, the state must have been created by
				// a previous signal - possibly in a previous epoch - so
				// only evolve if the state is initialized and ready.
				if (
					this.state[stateName].established === signal.blockNumber
					|| this.state[stateName].initialized
				) {

					// When an evolve signal is included in a state, the
					// store is reinitialized to signal's returned value
					this.state[stateName].set(signal, context);
				}
			}

		} else { // Including regular signal

			// For each of the states defined in this epoch
			for (let state of this.states) {

				// Give the state a chance to update itself
				state.set(signal, context);
			}
		}

		// Save the signal if it's not already
		this.included[signal.uuid] = signal.payload;
	}

	// Create a new state model on the epoch instance
	// or initialize a state from compressed data
	async loadState (meta, getInitialData) {

		// Create the state model
		const state = new State(meta);
		this.state[state.name] = state;

		// If the function to get the
		// initial data was provided
		if (getInitialData) {

			// Attempt to fetch the data - if call
			// succeeds use it to initialize state
			const data = await getInitialData(state);

			if (data) {
				await this.state[state.name].data(data);
			}
		}

		return this;
	}

	// Build epoch from initial states and signals
	async build (source = {}, getInitialData) {

		const build = source || {};
		const { initial, signals } = build;
		const map = {};

		// Map existing initial state meta data
		for (let state of this.initial) {
			map[state.name] = state._signed_;
		}

		// Map provided initial state meta data
		if (initial) {
			for (let item of initial) {
				const newState = item instanceof State ? item : new State(item);
				map[newState.name] = newState._signed_;
			}
		}

		// For each of the states that are not yet initialized,
		// attempt to do so if the initial data can be returned
		for (let stateName of Object.keys(map)) {
			if (!this.state[stateName] || !this.state[stateName].initialized) {
				await this.loadState(map[stateName], getInitialData);
			}
		}

		// If signal data provided
		if (signals) {

			// Save the signals if they're not already
			for (let data of signals) {
				const model = data instanceof Signal ? data : new Signal(data);
				this.included[model.uuid] = model.payload;
			}
		}

		// Include each signal in the epoch
		for (let signal of this.signals) {
			this.include(signal);
		}

		return this;
	}

	// Remove specificied signals and rebuild states
	async drop (which, getInitialData) {

		const dropped = [];

		// Remove dropped signals from included map
		for (let uuid of (Array.isArray(which) ? which : [ which ])) {
			if (this.included[uuid]) {
				dropped.push(new Signal(this.included[uuid]));
				delete this.included[uuid];
			}
		}

		// Rebuild the epoch without dropped signals
		await this.build({ signals: this.signals }, getInitialData);

		// Return dropped signals
		return dropped;
	}

	// Stage epoch for release
	async finalize (omega) {

		// The signals that will be included
		const signals = this.signals;

		if (signals.length === 0) {
			throw Error('An epoch must contain at least one signal');
		}

		// The highest block number among included signals
		const latest = signals[signals.length - 1].blockNumber;

		// Set final block number if provided, defaulting to latest
		this._signed_.omega = String(typeof omega === 'undefined' ? latest : omega);

		// Make sure all the signals get included
		if (latest > this.omega) {
			throw Error('Omega block cannot be less than block number of last signal');
		}

		// The minimum length of an epoch is one block
		if (this.omega < this.alpha) {
			throw Error('Omega block cannot be less than alpha block');
		}

		// Compute final data params for each state
		for (let state of this.states) {
			await state.build();
		}

		// Use the Torrent class data method to compute
		// data params without reinitializing states
		return super.data(Buffer.from(this.compressed));
	};

	// Return a successive epoch
	async next (options = {}) {

		if (!this.finalized) {
			throw Error('Epoch must be finalized before calling next');
		}

		// Construct the child epoch
		const next = new Epoch({

			// If not specified, inherit name from parent
			name: typeof options.name === 'undefined' ? this.name : options.name,
			
			// Next epoch always starts immediately after parent
			alpha: this.omega + 1,

			// Increment ordinal epoch number
			number: this.number + 1,

			// Record parent uuid
			ancestor: this.uuid
		});

		// Initialize new epoch with current final states
		for (let state of this.states) {
			await next.loadState(state.payload, () => {
				return Buffer.from(state.compressed);
			});
		}

		return next;
	}

	// If epoch's data has been loaded
	get initialized () {
		return this.signals.length > 0;
	};

	// Get array of signals in canonical order
	get signals () {
		const array = [];
		for (let uuid of Object.keys(this.included)) {
			array.push(new Signal(this.included[uuid]));
		}
		return array.sort((a, b) => { return a.compare(b); });
	}

	// Get sorted array of current initialized states
	get states () {
		const states = [];
		for (let stateName of Object.keys(this.state).sort()) {
			if (this.state[stateName].initialized) {
				states.push(this.state[stateName]);
			}
		}
		return states;
	}

	// Get states that existed at the beginning of epoch
	get initial () {

		const states = [];
		for (let stateName of Object.keys(this.state).sort()) {
			if (this.state[stateName].established < this.alpha) {
				states.push(this.state[stateName]);
			}
		}

		return states;
	}

	// Get uuid of previous epoch if it exists, or 'genesis'
	get ancestor () {
		return this.number === 0 ? 'genesis' : this._signed_.ancestor;
	}

	// Signer is alias for epoch name
	get signer () {
		return this.name;
	}

	// Ordinal number of epoch
	get number () {
		return parseInt(this._signed_.number);
	}

	// First block number in epoch
	get alpha () {
		return parseInt(this._signed_.alpha);
	}

	// Last block number in epoch
	get omega () {

		if (typeof this._signed_.omega === 'undefined') {
			return;
		}

		return parseInt(this._signed_.omega);
	}

	// Convenient way to check if new signals are being accepted
	get finalized () {
		return typeof this.omega !== 'undefined';
	}

	get compressed () {

		const signals = { clock: {}, block: {} };

		/*

		const signals = {
			clock: {
				[blockNumber]: [ hash, timestamp ]
			},
			block: {
				[blockNumber]: [ contained, alias, action, signature ]
			}
		};

		*/

		// Pack signals and block data efficiently
		for (let signal of this.signals) {

			// If there are not entries for this block number, create them
			if (typeof signals.clock[signal.blockNumber] === 'undefined') {
				signals.clock[signal.blockNumber] = [ signal.block, signal.timestamp ];
				signals.block[signal.blockNumber] = [];
			}

			const data = [ signal.contained ];

			// Add signal sender if defined
			if (typeof signal.sender !== 'undefined') {

				let _sender = utils.utf8ToHex(signal.sender).slice(2);

				// Append namespace if defined (null indicates top level alias)
				if (typeof signal.namespace === 'string') {
					_sender += `.${utils.utf8ToHex(signal.namespace).slice(2)}`;
				}

				data.push(_sender);
			}

			// Add the signal to its block number's array with
			// signed data and standard minimum parameters.
			signals.block[signal.blockNumber].push([
				...data,
				signal.action,
				signal.signature
			]);
		}
		
		// This allows a client that receives an epoch to download the
		// starting value for whichever states it cares about and then
		// iterate over the signals to get the state's current value.
		// Including states created *during* the epoch is unnecessary,
		// since their initial value is returned by an evolve signal.
		const initial = this.initial.map(state => {
			return state._signed_;
		});

		// Minify and gzip with @satellite-earth/parcel
		const parcel = new Parcel({ signals, initial });
		return parcel.packed;
	}
}

module.exports = Epoch;
