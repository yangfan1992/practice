var Router = require('../helpers/router.js'),
async = require('async'),
request = require('request'),
ip = require('ip'),
util = require('util'),
_ = require('underscore'),
zlib = require('zlib'),
extend = require('extend'),
crypto = require('crypto'),
bignum = require('../helpers/bignum.js'),
sandboxHelper = require('../helpers/sandbox.js');

// privated fields
var modules, library, self, privated = {}, shared = {};

privated.headers = {};
privated.loaded = false;
privated.messages = {};

// Constructor
function Transport(cb, scope) {
	library = scope;
	self = this;
	self.__private = privated;
	privated.attachApi();

	setImmediate(cb, null, self);
}

// private methods
privated.attachApi = function () {
	var router = new Router();

	router.use(function (req, res, next) {
		if (modules && privated.loaded) return next();
		res.status(500).send({success: false, error: "Blockchain is loading"});
	});

	router.use(function (req, res, next) {
		var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

		if (peerIp == "127.0.0.1") {
			return next();
		}

		if (!peerIp) {
			return res.status(500).send({success: false, error: "Wrong header data"});
		}

		req.headers.port = parseInt(req.headers.port);
		req.headers['share-port'] = parseInt(req.headers['share-port']);

		req.sanitize(req.headers, {
			type: "object",
			properties: {
				port: {
					type: "integer",
					minimum: 1,
					maximum: 65535
				},
				os: {
					type: "string",
					maxLength: 64
				},
				'share-port': {
					type: 'integer',
					minimum: 0,
					maximum: 1
				},
				'version': {
					type: 'string',
					maxLength: 11
				}
			},
			required: ["port", 'share-port', 'version']
		}, function (err, report, headers) {
			if (err) return next(err);
			if (!report.isValid) return res.status(500).send({status: false, error: report.issues});

			var peer = {
				ip: ip.toLong(peerIp),
				port: headers.port,
				state: 2,
				os: headers.os,
				sharePort: Number(headers['share-port']),
				version: headers.version
			};

			if (req.body && req.body.dappid) {
				peer.dappid = req.body.dappid;
			}

			if (peer.port > 0 && peer.port <= 65535 && peer.version == library.config.version) {
				modules.peer.update(peer);
			}

			next();
		});

	});

	router.get('/list', function (req, res) {
		res.set(privated.headers);
		modules.peer.list({limit: 100}, function (err, peers) {
			return res.status(200).json({peers: !err ? peers : []});
		});
	});

	router.get("/blocks/common", function (req, res, next) {
		res.set(privated.headers);

		req.sanitize(req.query, {
			type: "object",
			properties: {
				max: {
					type: 'integer'
				},
				min: {
					type: 'integer'
				},
				ids: {
					type: 'string',
					format: 'splitarray'
				}
			},
			required: ['max', 'min', 'ids']
		}, function (err, report, query) {
			if (err) return next(err);
			if (!report.isValid) return res.json({success: false, error: report.issue});


			var max = query.max;
			var min = query.min;
			var ids = query.ids.split(",").filter(function (id) {
				return /^\d+$/.test(id);
			});
			var escapedIds = ids.map(function (id) {
				return "'" + id + "'";
			});

			if (!escapedIds.length) {
				report = library.scheme.validate(req.headers, {
					type: "object",
					properties: {
						port: {
							type: "integer",
							minimum: 1,
							maximum: 65535
						}
					},
					required: ['port']
				});

				var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
				var peerStr = peerIp ? peerIp + ":" + (isNaN(parseInt(req.headers.port)) ? 'unkwnown' : parseInt(req.headers.port)) : 'unknown';
				library.logger.log('Invalid common block request, ban 60 min', peerStr);

				if (report) {
					modules.peer.state(ip.toLong(peerIp), RequestSanitizer.int(req.headers.port), 0, 3600);
				}

				return res.json({success: false, error: "Invalid block id sequence"});
			}

			library.dbLite.query("select max(height), id, previousBlock, timestamp from blocks where id in (" + escapedIds.join(',') + ") and height >= $min and height <= $max", {
				"max": max,
				"min": min
			}, {
				"height": Number,
				"id": String,
				"previousBlock": String,
				"timestamp": Number
			}, function (err, rows) {
				if (err) {
					return res.json({success: false, error: "Database error"});
				}

				var commonBlock = rows.length ? rows[0] : null;
				return res.json({success: true, common: commonBlock});
			});
		});
	});

	router.get("/blocks", function (req, res) {
		res.set(privated.headers);

		req.sanitize(req.query, {
			type: 'object',
			properties: {lastBlockId: {type: 'string'}}
		}, function (err, report, query) {
			if (err) return next(err);
			if (!report.isValid) return res.json({success: false, error: report.issues});

			// Get 1400+ blocks with all data (joins) from provided block id
			var blocksLimit = 1440;

			modules.blocks.loadBlocksData({
				limit: blocksLimit,
				lastId: query.lastBlockId
			}, {plain: true}, function (err, data) {
				res.status(200);
				if (err) {
					return res.json({blocks: ""});
				}

				res.json({blocks: data});

			});
		});
	});

	router.post("/blocks", function (req, res) {
		res.set(privated.headers);

		var report = library.scheme.validate(req.headers, {
			type: "object",
			properties: {
				port: {
					type: "integer",
					minimum: 1,
					maximum: 65535
				}
			},
			required: ['port']
		});

		var block;

		try {
			block = library.logic.block.objectNormalize(req.body.block);
		} catch (e) {
			var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
			var peerStr = peerIp ? peerIp + ":" + (isNaN(parseInt(req.headers.port)) ? 'unkwnown' : parseInt(req.headers.port)) : 'unknown';
			library.logger.log('Block ' + (block ? block.id : 'null') + ' is not valid, ban 60 min', peerStr);

			if (peerIp && report) {
				modules.peer.state(ip.toLong(peerIp), parseInt(req.headers.port), 0, 3600);
			}

			return res.sendStatus(200);
		}

		library.bus.message('receiveBlock', block);

		res.sendStatus(200);
	});

	router.post('/signatures', function (req, res) {
		res.set(privated.headers);

		library.scheme.validate(req.body, {
			type: "object",
			properties: {
				signature: {
					type: "object",
					properties: {
						transaction: {
							type: "string"
						},
						signature: {
							type: "string",
							format: "signature"
						}
					},
					required: ['transaction', 'signature']
				}
			},
			required: ['signature']
		}, function (err) {
			if (err) {
				return res.status(200).json({success: false, error: "Validation error"});
			}

			modules.multisignatures.processSignature(req.body.signature, function (err) {
				if (err) {
					return res.status(200).json({success: false, error: "Process signature error"});
				} else {
					return res.status(200).json({success: true});
				}
			});
		});
	});

	router.get('/signatures', function (req, res) {
		res.set(privated.headers);

		var unconfirmedList = modules.transactions.getUnconfirmedTransactionList();
		var signatures = [];

		async.eachSeries(unconfirmedList, function (trs, cb) {
			if (trs.signatures && trs.signatures.length) {
				signatures.push({
					transaction: trs.id,
					signatures: trs.signatures
				});
			}

			setImmediate(cb);
		}, function () {
			return res.status(200).json({success: true, signatures: signatures});
		});
	});

	router.get("/transactions", function (req, res) {
		res.set(privated.headers);
		// Need to process headers from peer
		res.status(200).json({transactions: modules.transactions.getUnconfirmedTransactionList()});
	});

	router.post("/transactions", function (req, res) {
		res.set(privated.headers);

		var report = library.scheme.validate(req.headers, {
			type: "object",
			properties: {
				port: {
					type: "integer",
					minimum: 1,
					maximum: 65535
				}
			},
			required: ['port']
		});
		var transaction;
		try {
			transaction = library.logic.transaction.objectNormalize(req.body.transaction);
		} catch (e) {
			var peerIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
			var peerStr = peerIp ? peerIp + ":" + (isNaN(req.headers.port) ? 'unknown' : req.headers.port) : 'unknown';
			library.logger.log('Received transaction ' + (transaction ? transaction.id : 'null') + ' is not valid, ban 60 min', peerStr);

			if (peerIp && report) {
				modules.peer.state(ip.toLong(peerIp), req.headers.port, 0, 3600);
			}

			return res.status(200).json({success: false, message: "Invalid transaction body"});
		}

		library.balancesSequence.add(function (cb) {
			modules.transactions.receiveTransactions([transaction], cb);
		}, function (err) {
			if (err) {
				res.status(200).json({success: false, message: err});
			} else {
				res.status(200).json({success: true});
			}
		});
	});

	router.get('/height', function (req, res) {
		res.set(privated.headers);
		res.status(200).json({
			height: modules.blocks.getLastBlock().height
		});
	});

	router.post("/dapp/message", function (req, res) {
		res.set(privated.headers);

		try {
			if (!req.body.dappid) {
				return res.status(200).json({success: false, message: "missed dappid"});
			}
			if (!req.body.timestamp || !req.body.hash) {
				return res.status(200).json({
					success: false,
					message: "missed hash sum"
				});
			}
			var newHash = privated.hashsum(req.body.body, req.body.timestamp);
			if (newHash !== req.body.hash) {
				return res.status(200).json({success: false, message: "wrong hash sum"});
			}
		} catch (e) {
			return res.status(200).json({success: false, message: e.toString()});
		}

		if (privated.messages[req.body.hash]) {
			return res.status(200);
		}

		privated.messages[req.body.hash] = true;

		modules.dapps.message(req.body.dappid, req.body.body, function (err, body) {
			if (!err && body.error) {
				err = body.error;
			}

			if (err) {
				return res.status(200).json({success: false, message: err});
			}

			library.bus.message('message', req.body, true);
			res.status(200).json(extend({}, body, {success: true}));
		});
	});

	router.post("/dapp/request", function (req, res) {
		res.set(privated.headers);

		try {
			if (!req.body.dappid) {
				return res.status(200).json({success: false, message: "missed dappid"});
			}
			if (!req.body.timestamp || !req.body.hash) {
				return res.status(200).json({
					success: false,
					message: "missed hash sum"
				});
			}
			var newHash = privated.hashsum(req.body.body, req.body.timestamp);
			if (newHash !== req.body.hash) {
				return res.status(200).json({success: false, message: "wrong hash sum"});
			}
		} catch (e) {
			return res.status(200).json({success: false, message: e.toString()});
		}

		modules.dapps.request(req.body.dappid, req.body.body.method, req.body.body.path, req.body.body.query, function (err, body) {
			if (!err && body.error) {
				err = body.error;
			}

			if (err) {
				return res.status(200).json({success: false, message: err});
			}

			res.status(200).json(extend({}, body, {success: true}));
		});
	});

	router.use(function (req, res, next) {
		res.status(500).send({success: false, error: "API endpoint not found"});
	});

	library.network.app.use('/peer', router);

	library.network.app.use(function (err, req, res, next) {
		if (!err) return next();
		library.logger.error(req.url, err.toString());
		res.status(500).send({success: false, error: err.toString()});
	});
};