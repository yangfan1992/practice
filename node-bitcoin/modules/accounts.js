var crypto = require('crypto'),
  bignum = require('../helpers/bignum.js'),
  ed = require('ed25519'),
  slots = require('../helpers/slots.js'),
  Router = require('../helpers/router.js'),
  util = require('util'),
  constants = require('../helpers/constants.js'),
  TransactionTypes = require('../helpers/transaction-types.js'),
  Diff = require('../helpers/diff.js'),
  util = require('util'),
  extend = require('extend'),
  sandboxHelper = require('../helpers/sandbox.js');

// privated fields
var modules, library, self, privated = {}, shared = {};

function Vote() {
	this.create = function (data, trs) {
		trs.recipientId = data.sender.address;
		trs.recipientUsername = data.sender.username;
		trs.asset.votes = data.votes;

		return trs;
	};

	this.calculateFee = function (trs, sender) {
		return 1 * constants.fixedPoint;
	};

	this.verify = function (trs, sender, cb) {
		if (trs.recipientId != trs.senderId) {
			return setImmediate(cb, "Recipient is identical to sender");
		}

		if (!trs.asset.votes || !trs.asset.votes.length) {
			return setImmediate(cb, "Not enough spare votes available");
		}

		if (trs.asset.votes && trs.asset.votes.length > 33) {
			return setImmediate(cb, "Voting limited exceeded. Maxmium is 33 per transaction");
		}

		modules.delegates.checkDelegates(trs.senderPublicKey, trs.asset.votes, function (err) {
			setImmediate(cb, err, trs);
		});
	};

	this.process = function (trs, sender, cb) {
		setImmediate(cb, null, trs);
  };
  
	this.getBytes = function (trs) {
		try {
			var buf = trs.asset.votes ? new Buffer(trs.asset.votes.join(''), 'utf8') : null;
		} catch (e) {
			throw Error(e.toString());
		}

		return buf;
	};

	this.apply = function (trs, block, sender, cb) {
		this.scope.account.merge(sender.address, {
			delegates: trs.asset.votes,
			blockId: block.id,
			round: modules.round.calc(block.height)
		}, function (err) {
			cb(err);
		});
	};

	this.undo = function (trs, block, sender, cb) {
		if (trs.asset.votes === null) return cb();

		var votesInvert = Diff.reverse(trs.asset.votes);

		this.scope.account.merge(sender.address, {
			delegates: votesInvert,
			blockId: block.id,
			round: modules.round.calc(block.height)
		}, function (err) {
			cb(err);
		});
  };
  
  this.applyUnconfirmed = function (trs, sender, cb) {
		modules.delegates.checkUnconfirmedDelegates(trs.senderPublicKey, trs.asset.votes, function (err) {
			if (err) {
				return setImmediate(cb, err);
			}

			this.scope.account.merge(sender.address, {
				u_delegates: trs.asset.votes
			}, function (err) {
				cb(err);
			});
		}.bind(this));
	};

	this.undoUnconfirmed = function (trs, sender, cb) {
		if (trs.asset.votes === null) return cb();

		var votesInvert = Diff.reverse(trs.asset.votes);

		this.scope.account.merge(sender.address, {u_delegates: votesInvert}, function (err) {
			cb(err);
		});
  };
  
  this.objectNormalize = function (trs) {
		var report = library.scheme.validate(trs.asset, {
			type: "object",
			properties: {
				votes: {
					type: "array",
					minLength: 1,
					maxLength: 105,
					uniqueItems: true
				}
			},
			required: ['votes']
		});

		if (!report) {
			throw new Error("Incorrect votes in transactions: " + library.scheme.getLastError());
		}

		return trs;
  };
  
  this.dbRead = function (raw) {
		// console.log(raw.v_votes);

		if (!raw.v_votes) {
			return null;
		} else {
			var votes = raw.v_votes.split(',');

			return {votes: votes};
		}
  };
  
  this.dbSave = function (trs, cb) {
		library.dbLite.query("INSERT INTO votes(votes, transactionId) VALUES($votes, $transactionId)", {
			votes: util.isArray(trs.asset.votes) ? trs.asset.votes.join(',') : null,
			transactionId: trs.id
		}, cb);
	};

	this.ready = function (trs, sender) {
		if (sender.multisignatures.length) {
			if (!trs.signatures) {
				return false;
			}
			return trs.signatures.length >= sender.multimin - 1;
		} else {
			return true;
		}
	};
}

function Username() {
	this.create = function (data, trs) {
		trs.recipientId = null;
		trs.amount = 0;
		trs.asset.username = {
			alias: data.username,
			publicKey: data.sender.publicKey
		};

		return trs;
	};

	this.calculateFee = function (trs, sender) {
		return 100 * constants.fixedPoint;
  };

  this.verify = function (trs, sender, cb) {
		if (trs.recipientId) {
			return setImmediate(cb, "Invalid recipient");
		}

		if (trs.amount !== 0) {
			return setImmediate(cb, "Invalid transaction amount");
		}

		if (!trs.asset.username.alias) {
			return setImmediate(cb, "Invalid transaction asset");
		}

		var allowSymbols = /^[a-z0-9!@$&_.]+$/g;
		if (!allowSymbols.test(trs.asset.username.alias.toLowerCase())) {
			return setImmediate(cb, "Username must only contain alphanumeric characters (with the exception of !@$&_)");
		}

		var isAddress = /^[0-9]+[L|l]$/g;
		if (isAddress.test(trs.asset.username.alias.toLowerCase())) {
			return setImmediate(cb, "Username cannot be a potential address");
		}

		if (trs.asset.username.alias.length === 0 || trs.asset.username.alias.length > 20) {
			return setImmediate(cb, "Invalid username length. Must be between 1 to 20 characters");
    }
    
    self.getAccount({
			$or: {
				username: trs.asset.username.alias,
				u_username: trs.asset.username.alias
			}
		}, function (err, account) {
			if (err) {
				return cb(err);
			}
			if (account && account.username == trs.asset.username.alias) {
				return cb("Username already exists");
			}
			if (sender.username && sender.username != trs.asset.username.alias) {
				return cb("Invalid username. Does not match transaction asset");
			}
			if (sender.u_username && sender.u_username != trs.asset.username.alias) {
				return cb("Account already has a username");
			}

			cb(null, trs);
		});
  };
  
  this.process = function (trs, sender, cb) {
		setImmediate(cb, null, trs);
	};

	this.getBytes = function (trs) {
		try {
			var buf = new Buffer(trs.asset.username.alias, 'utf8');
		} catch (e) {
			throw Error(e.toString());
		}

		return buf;
	};

	this.apply = function (trs, block, sender, cb) {
		self.setAccountAndGet({
			address: sender.address,
			u_username: null,
			username: trs.asset.username.alias,
			nameexist: 1,
			u_nameexist: 0
		}, cb);
  };
  
  this.undo = function (trs, block, sender, cb) {
		self.setAccountAndGet({
			address: sender.address,
			username: null,
			u_username: trs.asset.username.alias,
			nameexist: 0,
			u_nameexist: 1
		}, cb);
	};

	this.applyUnconfirmed = function (trs, sender, cb) {
		if (sender.username || sender.u_username) {
			return setImmediate(cb, "Account already has a username");
		}

		var address = modules.accounts.generateAddressByPublicKey(trs.senderPublicKey);

		self.getAccount({
			$or: {
				u_username: trs.asset.username.alias,
				address: address
			}
		}, function (err, account) {
			if (err) {
				return cb(err);
			}
			if (account && account.u_username) {
				return cb("Username already exists");
			}

			self.setAccountAndGet({address: sender.address, u_username: trs.asset.username.alias, u_nameexist: 1}, cb);
    });
    
    this.undoUnconfirmed = function (trs, sender, cb) {
      self.setAccountAndGet({address: sender.address, u_username: null, u_nameexist: 0}, cb);
    };
  
    this.objectNormalize = function (trs) {
      var report = library.scheme.validate(trs.asset.username, {
        type: "object",
        properties: {
          alias: {
            type: "string",
            minLength: 1,
            maxLength: 20
          },
          publicKey: {
            type: 'string',
            format: 'publicKey'
          }
        },
        required: ['alias', 'publicKey']
      });
  
      if (!report) {
        throw Error(library.scheme.getLastError());
      }
  
      return trs;
    };
  };

  this.dbRead = function (raw) {
		if (!raw.u_alias) {
			return null;
		} else {
			var username = {
				alias: raw.u_alias,
				publicKey: raw.t_senderPublicKey
			};

			return {username: username};
		}
	};

	this.dbSave = function (trs, cb) {
		library.dbLite.query("INSERT INTO usernames(username, transactionId) VALUES($username, $transactionId)", {
			username: trs.asset.username.alias,
			transactionId: trs.id
		}, cb);
	};

	this.ready = function (trs, sender) {
		if (sender.multisignatures.length) {
			if (!trs.signatures) {
				return false;
			}
			return trs.signatures.length >= sender.multimin - 1;
		} else {
			return true;
		}
	};
}

// Constructor
function Accounts(cb, scope) {
	library = scope;
	self = this;
	self.__private = privated;
	privated.attachApi();

	library.logic.transaction.attachAssetType(TransactionTypes.VOTE, new Vote());
	library.logic.transaction.attachAssetType(TransactionTypes.USERNAME, new Username());

	setImmediate(cb, null, self);
}

// private methods
privated.attachApi = function () {
	var router = new Router();

	router.use(function (req, res, next) {
		if (modules) return next();
		res.status(500).send({success: false, error: "Blockchain is loading"});
  });

  router.map(shared, {
		"post /open": "open",
		"get /getBalance": "getBalance",
		"get /getPublicKey": "getPublickey",
		"post /generatePublicKey": "generatePublickey",
		"get /delegates": "getDelegates",
		"get /delegates/fee": "getDelegatesFee",
		"put /delegates": "addDelegates",
		"get /username/get": "getUsername",
		"get /username/fee": "getUsernameFee",
		"put /username": "addUsername",
		"get /": "getAccount"
	});

	if (process.env.DEBUG && process.env.DEBUG.toUpperCase() == "TRUE") {
		router.get('/getAllAccounts', function (req, res) {
			return res.json({success: true, accounts: privated.accounts});
		});
  }
  
  if (process.env.TOP && process.env.TOP.toUpperCase() == "TRUE") {
		router.get('/top', function (req, res, next) {
			req.sanitize(req.query, {
				type: "object",
				properties: {
					limit: {
						type: "integer",
						minimum: 0,
						maximum: 100
					},
					offset: {
						type: "integer",
						minimum: 0
					}
        }
      }, function (err, report, query) {
				if (err) return next(err);
				if (!report.isValid) return res.json({success: false, error: report.issues});
				self.getAccounts({
					sort: {
						balance: -1
					},
					offset: query.offset,
					limit: query.limit
				}, function (err, raw) {
					if (err) {
						return res.json({success: false, error: err.toString()});
					}
					var accounts = raw.map(function (fullAccount) {
						return {
							address: fullAccount.address,
							username: fullAccount.username,
							balance: fullAccount.balance,
							publicKey: fullAccount.publicKey
						};
					});

					res.json({success: true, accounts: accounts});
				});
			});
		});
  }
  
  router.get('/count', function (req, res) {
		return res.json({success: true, count: Object.keys(privated.accounts).length});
	});

	router.use(function (req, res, next) {
		res.status(500).send({success: false, error: "API endpoint was not found"});
	});

	library.network.app.use('/api/accounts', router);
	library.network.app.use(function (err, req, res, next) {
		if (!err) return next();
		library.logger.error(req.url, err.toString());
		res.status(500).send({success: false, error: err.toString()});
  });
  
  privated.openAccount = function (secret, cb) {
    var hash = crypto.createHash('sha256').update(secret, 'utf8').digest();
    var keypair = ed.MakeKeypair(hash);
  
    self.setAccountAndGet({publicKey: keypair.publicKey.toString('hex')}, cb);
  };
};

// Public methods
Accounts.prototype.generateAddressByPublicKey = function (publicKey) {
	var publicKeyHash = crypto.createHash('sha256').update(publicKey, 'hex').digest();
	var temp = new Buffer(8);
	for (var i = 0; i < 8; i++) {
		temp[i] = publicKeyHash[7 - i];
	}

	var address = bignum.fromBuffer(temp).toString() + 'L';
	if (!address) {
		throw Error("wrong publicKey " + publicKey);
	}
	return address;
};

Accounts.prototype.getAccount = function (filter, fields, cb) {
	if (filter.publicKey) {
		filter.address = self.generateAddressByPublicKey(filter.publicKey);
		delete filter.publicKey;
	}

	library.logic.account.get(filter, fields, cb);
};

Accounts.prototype.getAccounts = function (filter, fields, cb) {
	library.logic.account.getAll(filter, fields, cb);
};

Accounts.prototype.setAccountAndGet = function (data, cb) {
	var address = data.address || null;
	if (address === null) {
		if (data.publicKey) {
			address = self.generateAddressByPublicKey(data.publicKey);
		} else {
			return cb("Missing address or public key");
		}
	}
	if (!address) {
		throw cb("Invalid public key");
	}
	library.logic.account.set(address, data, function (err) {
		if (err) {
			return cb(err);
		}
		library.logic.account.get({address: address}, cb);
	});
};

Accounts.prototype.mergeAccountAndGet = function (data, cb) {
	var address = data.address || null;
	if (address === null) {
		if (data.publicKey) {
			address = self.generateAddressByPublicKey(data.publicKey);
		} else {
			return cb("Missing address or public key");
		}
	}
	if (!address) {
		throw cb("Invalid public key");
	}
	library.logic.account.merge(address, data, cb);
};

Accounts.prototype.sandboxApi = function (call, args, cb) {
	sandboxHelper.callMethod(shared, call, args, cb);
};

// Events
Accounts.prototype.onBind = function (scope) {
	modules = scope;
};

// Shared
shared.open = function (req, cb) {
	var body = req.body;
	library.scheme.validate(body, {
		type: "object",
		properties: {
			secret: {
				type: "string",
				minLength: 1,
				maxLength: 100
			}
		},
		required: ["secret"]
	}, function (err) {
		if (err) {
			return cb(err[0].message);
		}

		privated.openAccount(body.secret, function (err, account) {
			var accountData = null;
			if (!err) {
				accountData = {
					address: account.address,
					unconfirmedBalance: account.u_balance,
					balance: account.balance,
					publicKey: account.publicKey,
					unconfirmedSignature: account.u_secondSignature,
					secondSignature: account.secondSignature,
					secondPublicKey: account.secondPublicKey,
					multisignatures: account.multisignatures,
					u_multisignatures: account.u_multisignatures
				};

				return cb(null, {account: accountData});
			} else {
				return cb(err);
			}
		});
	});
};
