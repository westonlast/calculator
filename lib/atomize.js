/*global WeakMap, Map, Proxy, SockJS, Cereal, exports, require */
/*jslint browser: true, devel: true */

var Atomize;

function NotATVarException() {}
NotATVarException.prototype.toString = function () {
    return "Not A TVar";
};
function WriteOutsideTransactionException() {}
WriteOutsideTransactionException.prototype.toString = function () {
    return "Write outside transaction";
};
function DeleteOutsideTransactionException() {}
DeleteOutsideTransactionException.prototype.toString = function () {
    return "Delete outside transaction";
};
function RetryOutsideTransactionException() {}
RetryOutsideTransactionException.prototype.toString = function () {
    return "Retry outside transaction";
};
function InternalException() {}
InternalException.prototype.toString = function () {
    return "Internal Exception";
};

(function (window) {
    'use strict';

    var util, STM, Cereal;

    if (typeof exports !== "undefined") {
        Cereal = require('cereal');

        if (typeof Proxy === "undefined" || typeof WeakMap === "undefined") {
            console.error("Node is running on too old a version of v8. " +
                          "Atomize requires node to be running with v8 " +
                          "version 3.7.3 or better.");
            return;
        }
    } else {
        Cereal = window.Cereal;

        if (typeof Cereal === "undefined") {
            console.error("Please load the cereal.js script before the atomize.js script.");
            return;
        }

        if (typeof Proxy === "undefined" || typeof WeakMap === "undefined") {
            console.error("Your browser is too old. Currently the only known " +
                          "compatible browsers are Chrome version 17 or better, " +
                          "and Firefox 8.0 or better.");
            return;
        }
    }

    util = (function () {
        return {
            isPrimitive: function (obj) {
                return obj !== Object(obj);
            },

            hasOwnProp: ({}).hasOwnProperty
        };
    }());

    (function () {

        function TVar(id, obj, stm) {
            this.id = id;
            this.raw = obj;
            this.stm = stm;
            this.version = 0;
            if (typeof obj === "function") {
                this.proxied = this.functionHandlerMaker(obj);
            } else {
                this.proxied = Proxy.create(this.objHandlerMaker(obj), Object.getPrototypeOf(obj));
            }
        }

        TVar.prototype = {

            log: function (msgs) {
                if (typeof msgs === "string") {
                    this.stm.log(["[TVar ", this.id, "] ", msgs]);
                } else {
                    this.stm.log(["[TVar ", this.id, "] "].concat(msgs));
                }
            },

            functionHandlerMaker: function (func) {
                var self, callTrap, ctrTrap, myCtr;
                self = this;
                callTrap = function () {
                    return func.apply(this, arguments);
                };
                ctrTrap = function () {
                    var args, Ctr;
                    args = arguments;
                    Ctr = function () {
                        func.apply(this, args);
                    };
                    func.prototype = self.proxied.prototype;
                    Ctr.prototype = self.proxied.prototype;
                    return new Ctr();
                };
                return Proxy.createFunction(this.objHandlerMaker(func), callTrap, ctrTrap);
            },

            objHandlerMaker: function (obj) {
                var self, stm;

                self = this;
                stm = self.stm;

                return {

                    getOwnPropertyDescriptor: function (name) {
                        self.log(["getOwnPropertyDescriptor: ", name]);
                        var desc, tvar;
                        stm.recordRead(self);
                        if (! stm.inTransaction()) {
                            desc = Object.getOwnPropertyDescriptor(obj, name);
                        } else if (stm.transactionFrame.isDeleted(self, name)) {
                            return undefined;
                        } else {
                            tvar = stm.transactionFrame.get(self, name);
                            if (undefined === tvar) {
                                desc = Object.getOwnPropertyDescriptor(obj, name);
                            } else {
                                desc = Object.getOwnPropertyDescriptor(tvar, 'value');
                            }
                        }
                        if (undefined !== desc) {
                            desc.configurable = true;
                        }
                        return desc;
                    },

                    getPropertyDescriptor: function (name) {
                        self.log(["getPropertyDescriptor: ", name]);
                        var desc, tmp, proto, tvar;
                        stm.recordRead(self);
                        if (undefined === Object.getPropertyDescriptor) {
                            tmp = undefined;
                            proto = self.proxied;
                            while (proto !== undefined && proto !== null && proto !== tmp) {
                                tmp = proto;
                                if (! stm.inTransaction()) {
                                    desc = Object.getOwnPropertyDescriptor(tmp, name);
                                } else if (stm.transactionFrame.isDeleted(tmp, name)) {
                                    return undefined;
                                } else {
                                    tvar = stm.transactionFrame.get(tmp, name);
                                    if (undefined === tvar) {
                                        desc = Object.getOwnPropertyDescriptor(tmp, name);
                                    } else {
                                        desc = Object.getOwnPropertyDescriptor(tvar, 'value');
                                    }
                                }
                                if (undefined === desc) {
                                    proto = Object.getPrototypeOf(tmp);
                                } else {
                                    desc.configurable = true;
                                    return desc;
                                }
                            }
                            return undefined;
                        } else {
                            if (! stm.inTransaction()) {
                                desc = Object.getPropertyDescriptor(obj, name);
                            } else if (stm.transactionFrame.isDeleted(self, name)) {
                                return undefined;
                            } else {
                                tvar = stm.transactionFrame.get(self, name);
                                if (undefined === tvar) {
                                    desc = Object.getPropertyDescriptor(obj, name);
                                } else {
                                    desc = Object.getPropertyDescriptor(tvar, 'value');
                                }
                            }
                            if (undefined !== desc) {
                                desc.configurable = true;
                            }
                            return desc;
                        }
                    },

                    getOwnPropertyNames: function () {
                        self.log("getOwnPropertyNames");
                        stm.recordRead(self);
                        var names, result, i;
                        if (stm.inTransaction()) {
                            names = stm.transactionFrame.getOwnPropertyNames(self).concat(
                                Object.getOwnPropertyNames(obj));
                            result = {};
                            for (i = 0; i < names.length; i += 1) {
                                if (! stm.transactionFrame.isDeleted(self, names[i])) {
                                    result[names[i]] = true;
                                }
                            }
                            return Object.keys(result);
                        } else {
                            return Object.getOwnPropertyNames(obj);
                        }
                    },

                    getPropertyNames: function () {
                        self.log("getPropertyNames");
                        stm.recordRead(self);
                        var result, seen, tmp, names, proto, i;
                        result = [];
                        seen = {};
                        tmp = undefined;
                        proto = self.proxied;
                        while (proto !== undefined && proto !== null && proto !== tmp) {
                            tmp = proto;
                            names = Object.getOwnPropertyNames(tmp);
                            for (i = 0; i < names.length; i += 1) {
                                if (! util.hasOwnProp.call(seen, names[i])) {
                                    seen[names[i]] = true;
                                    result.push(names[i]);
                                }
                            }
                            proto = Object.getPrototypeOf(tmp);
                        }
                        return result;
                    },

                    defineProperty: function (name, desc) {
                        self.log("*** defineProperty ***");
                        // TODO - make transaction aware.
                        Object.defineProperty(obj, name, desc);
                    },

                    delete: function (name) {
                        self.log(["delete: ", name]);
                        if (stm.inTransaction()) {
                            stm.transactionFrame.recordDelete(self, name);
                            // Just like in set: we don't do the delete here
                        } else {
                            throw new DeleteOutsideTransactionException();
                        }
                        return true; // TODO - lookup when this shouldn't return true
                    },

                    fix: function () {
                        // TODO - make transaction aware. Somehow. Might not be possible...
                        self.log("*** fix ***");
                        if (Object.isFrozen(obj)) {
                            var result = {};
                            Object.getOwnPropertyNames(obj).forEach(function (name) {
                                result[name] = Object.getOwnPropertyDescriptor(obj, name);
                            });
                            return result;
                        }
                        // As long as obj is not frozen, the proxy won't allow
                        // itself to be fixed
                        return undefined; // will cause a TypeError to be thrown
                    },

                    has: function (name) {
                        self.log(["has: ", name]);
                        var tvar;
                        stm.recordRead(self);
                        if (! stm.inTransaction()) {
                            return name in obj;
                        } else if (stm.transactionFrame.isDeleted(self, name)) {
                            return false;
                        } else {
                            tvar = stm.transactionFrame.get(self, name);
                            if (undefined === tvar) {
                                return name in obj;
                            } else {
                                return true;
                            }
                        }
                    },

                    hasOwn: function (name) {
                        self.log(["hasOwn: ", name]);
                        var tvar;
                        stm.recordRead(self);
                        if (! stm.inTransaction()) {
                            return util.hasOwnProp.call(obj, name);
                        } else if (stm.transactionFrame.isDeleted(self, name)) {
                            return false;
                        } else {
                            tvar = stm.transactionFrame.get(self, name);
                            if (undefined === tvar) {
                                return util.hasOwnProp.call(obj, name);
                            } else {
                                return true;
                            }
                        }
                    },

                    get: function (receiver, name) {
                        self.log(["get: ", name]);
                        var result, proxied, tvar;
                        stm.recordRead(self);
                        if (! stm.inTransaction()) {
                            return obj[name];
                        } else if (stm.transactionFrame.isDeleted(self, name)) {
                            self.log("...has been deleted");
                            return undefined;
                        } else {
                            tvar = stm.transactionFrame.get(self, name);
                            if (undefined === tvar) {
                                if (util.hasOwnProp.call(obj, name)) {
                                    result = obj[name];
                                    if (undefined === result || util.isPrimitive(result)) {
                                        self.log("...found and not object");
                                        return result;
                                    }
                                    tvar = stm.ensureTVar(result);
                                    proxied = tvar.proxied;
                                    if (proxied === result) {
                                        self.log("...found in cache");
                                    } else {
                                        // rewrite our local graph to use the proxied version
                                        self.log("...implicity lifted");
                                        stm.transactionFrame.recordWrite(self, name, proxied);
                                    }
                                    return proxied;
                                } else {
                                    result = Object.getPrototypeOf(self.proxied);
                                    if (null === result || undefined === result ||
                                        result === obj || result === self.proxied) {
                                        self.log("...not found");
                                        return undefined;
                                    }
                                    self.log("...deferring to prototype");
                                    return stm.ensureTVar(result).proxied[name];
                                }
                            } else {
                                self.log("...found in txn log");
                                return tvar.value;
                            }
                        }
                    },

                    set: function (receiver, name, val) {
                        self.log(["set: ", name]);
                        if (stm.inTransaction()) {
                            if (undefined === val ||
                                util.isPrimitive(val) ||
                                stm.isProxied(val)) {
                                stm.transactionFrame.recordWrite(self, name, val);
                                // Note we don't actually do the write here!
                                return true;
                            } else {
                                // it's not a tvar, explode
                                throw new NotATVarException();
                            }
                        } else {
                            throw new WriteOutsideTransactionException();
                        }
                    }, // bad behavior when set fails in non-strict mode

                    enumerate: function () {
                        self.log("enumerate");
                        var result, name, keys, tmp, proto, seen, i;
                        stm.recordRead(self);
                        result = [];
                        if (stm.inTransaction()) {
                            seen = {};
                            tmp = undefined;
                            proto = self.proxied;
                            while (proto !== undefined && proto !== null && proto !== tmp) {
                                tmp = proto;
                                keys = Object.keys(tmp);
                                for (i = 0; i < keys.length; i += 1) {
                                    if (! util.hasOwnProp.call(seen, keys[i])) {
                                        seen[keys[i]] = true;
                                        result.push(keys[i]);
                                    }
                                }
                                proto = Object.getPrototypeOf(tmp);
                            }
                            self.log(["...enumerate => ", result]);
                            return result;
                        } else {
                            for (name in obj) {
                                if (undefined !== name) {
                                    result.push(name);
                                }
                            }
                        }
                        return result;
                    },

                    keys: function () {
                        self.log("keys");
                        var names, seen, result, i;
                        stm.recordRead(self);
                        if (stm.inTransaction()) {
                            names = Object.keys(obj).concat(stm.transactionFrame.keys(self));
                            result = [];
                            seen = {};
                            for (i = 0; i < names.length; i += 1) {
                                if (! util.hasOwnProp.call(seen, names[i])) {
                                    seen[names[i]] = true;
                                    if (! stm.transactionFrame.isDeleted(self, names[i])) {
                                        result.push(names[i]);
                                    }
                                }
                            }
                            return result;
                        } else {
                            return Object.keys(obj);
                        }
                    }
                };
            }
        };


        function Transaction(stm, id, parent, funs, cont) {
            this.stm = stm;
            this.id = id;
            this.funs = funs;
            this.funIndex = 0;
            this.cont = cont;
            this.parent = parent;

            this.read = {};
            this.created = {};
            this.written = {};

            this.readStack = [];
        }

        Transaction.prototype = {
            retryException: {},
            deleted: {},

            log: function (msgs) {
                if (typeof msgs === "string") {
                    this.stm.log(["[Txn ", this.id, "] ", msgs]);
                } else {
                    this.stm.log(["[Txn ", this.id, "] "].concat(msgs));
                }
            },

            reset: function (full) {
                if (0 === this.funIndex) {
                    this.readStack = [];
                } else if (Object.keys(this.read).length !== 0) {
                    this.readStack.push(this.read);
                }
                this.read = {};
                this.written = {};
                if (full) {
                    this.created = {};
                }
            },

            recordRead: function (parent) {
                this.read[parent.id] = parent.version;
            },

            recordCreation: function (value) {
                this.created[value.id] = value;
            },

            recordDelete: function (parent, name) {
                this.recordWrite(parent, name, this.deleted);
            },

            recordWrite: function (parent, name, value) {
                if (! util.hasOwnProp.call(this.written, parent.id)) {
                    this.written[parent.id] = {tvar: parent,
                                               children: {}};
                }
                // this could get messy - name could be 'constructor', for
                // example.
                this.written[parent.id].children[name] = value;
            },

            get: function (parent, name) {
                if (util.hasOwnProp.call(this.written, parent.id) &&
                    util.hasOwnProp.call(this.written[parent.id].children, name)) {
                    if (this.deleted === this.written[parent.id].children[name]) {
                        return undefined;
                    } else {
                        return {value: this.written[parent.id].children[name]};
                    }
                }
                if (undefined === this.parent) {
                    return undefined;
                } else {
                    return this.parent.get(parent, name);
                }
            },

            isDeleted: function (parent, name) {
                if (util.hasOwnProp.call(this.written, parent.id) &&
                    util.hasOwnProp.call(this.written[parent.id].children, name)) {
                    return this.deleted === this.written[parent.id].children[name];
                }
                if (undefined === this.parent) {
                    return false;
                } else {
                    return this.parent.isDeleted(parent, name);
                }
            },

            keys: function (parent, predicate) {
                var result, worklist, seen, obj, vars, keys, i;
                result = [];
                worklist = [];
                seen = {};

                if (undefined === predicate) {
                    predicate = function (obj, key) {
                        return Object.getOwnPropertyDescriptor(obj, key).enumerable;
                    };
                }

                obj = this;
                while (undefined !== obj) {
                    if (util.hasOwnProp.call(obj.written, parent.id)) {
                        worklist.push(obj.written[parent.id].children);
                    }
                    obj = obj.parent;
                }
                while (0 < worklist.length) {
                    vars = worklist.shift();
                    keys = Object.keys(vars);
                    for (i = 0; i < keys.length; i += 1) {
                        if (! util.hasOwnProp.call(seen, keys[i])) {
                            seen[keys[i]] = true;
                            if ((this.deleted !== vars[keys[i]]) && predicate(vars, keys[i])) {
                                result.push(keys[i]);
                            }
                        }
                    }
                }
                return result;
            },

            getOwnPropertyNames: function (parent) {
                return this.keys(parent, function (obj, key) { return true; });
            },

            run: function () {
                var result, index;
                if (undefined !== this.stm.transactionFrame &&
                    this.parent !== this.stm.transactionFrame &&
                    this !== this.stm.transactionFrame) {
                    throw "Internal Failure";
                }
                this.funIndex = 0;
                index = -1;
                this.stm.transactionFrame = this;
                while (true) {
                    try {
                        index = this.funIndex;
                        return this.commit(this.funs[this.funIndex]());
                    } catch (err) {
                        if (err === this.retryException) {
                            if (0 === this.funIndex) {
                                // If 0 === this.funIndex then we have
                                // done a full retry and are now
                                // waiting on the server. Thus we
                                // should continue unwinding the stack
                                // and thus rethrow if we have a
                                // parent. If we don't have a parent
                                // then we should just absorb the
                                // exception and exit the loop.

                                if (undefined !== this.parent) {
                                    throw err;
                                } else {
                                    return;
                                }
                            } else {
                                // If 0 !== this.funIndex then we're
                                // in an orElse and we've hit a retry
                                // which we're going to service by
                                // changing to the next alternative
                                // and going round the loop
                                // again. Thus absorb the exception,
                                // and don't exit the loop. Do a
                                // partial reset - throw out the
                                // writes but keep the reads that led
                                // us here (and keep the creates -
                                // they won't be grabbed by the server
                                // until we do a commit).
                                this.reset(false);
                            }
                        } else {
                            this.stm.transactionFrame = this.parent;
                            throw err;
                        }
                    }
                }
            },

            commit: function (result) {
                var self, success, failure, txnLog, worklist, obj, keys, i;

                if (undefined === this.parent) {
                    self = this;
                    txnLog = this.cerealise();
                    this.stm.transactionFrame = undefined;

                    // All created vars are about to become
                    // public. Thus bump vsn to 1.
                    keys = Object.keys(self.created).sort();
                    for (i = 0; i < keys.length; i += 1) {
                        obj = this.created[keys[i]];
                        if (obj.version === 0) {
                            obj.version = 1;
                        }
                    }

                    success = function () {
                        var ids, names, i, j, parent, tvar, name, value;
                        ids = Object.keys(self.written).sort();
                        for (i = 0; i < ids.length; i += 1) {
                            parent = self.written[ids[i]];
                            tvar = parent.tvar;
                            tvar.version += 1;
                            self.log("incr " + tvar.id + " to " + tvar.version);
                            names = Object.keys(parent.children);
                            for (j = 0; j < names.length; j += 1) {
                                name = names[j];
                                value = parent.children[name];
                                if (self.deleted === value) {
                                    self.log(["Committing delete to ", ids[i], ".", name]);
                                    delete tvar.raw[name];
                                } else {
                                    self.log(["Committing write to ", ids[i], ".", name]);
                                    tvar.raw[name] = value;
                                }
                            }
                        }

                        if (undefined === self.cont) {
                            return result;
                        }
                        return self.cont(result);
                    };

                    failure = function () {
                        // As we're in commit, created vars will be
                        // grabbed even on a failed commit. Thus do a
                        // full reset here.
                        self.reset(true);
                        return self.run();
                    };

                    txnLog.type = "commit";

                    return this.stm.server.commit(txnLog, success, failure);

                } else {
                    // TODO - we could do a validation here - not a
                    // full commit. Would require server support.

                    this.stm.transactionFrame = this.parent;

                    worklist = [this.read].concat(this.readStack);
                    while (worklist.length !== 0) {
                        obj = worklist.shift();
                        keys = Object.keys(obj);
                        for (i = 0; i < keys.length; i += 1) {
                            this.parent.read[keys[i]] = obj[keys[i]];
                        }
                    }

                    keys = Object.keys(this.created);
                    for (i = 0; i < keys.length; i += 1) {
                        this.parent.created[keys[i]] = this.created[keys[i]];
                    }

                    keys = Object.keys(this.written);
                    for (i = 0; i < keys.length; i += 1) {
                        this.parent.written[keys[i]] = this.written[keys[i]];
                    }

                    if (undefined === this.cont) {
                        return result;
                    }
                    return this.cont(result);
                }
            },

            retry: function () {
                var self, restart, txnLog;

                this.funIndex += 1;
                if (this.funIndex === this.funs.length) {
                    this.funIndex = 0;
                }

                if (0 === this.funIndex) {
                    self = this;
                    txnLog = this.cerealise({read: true});
                    this.stm.transactionFrame = undefined;

                    restart = function () {
                        // In a retry, we only send up the reads, not
                        // createds. So don't reset the createds.
                        self.reset(false);
                        return self.run();
                    };

                    txnLog.type = "retry";

                    this.stm.server.retry(txnLog, restart);
                }

                throw this.retryException;
            },

            cerealise: function (obj) {
                var worklist, seen, keys, i, self, parent, names, j, value;
                self = this;

                if (undefined === obj) {
                    obj = {read: {},
                           created: {},
                           written: {},
                           txnId: this.id};
                } else {
                    obj.txnId = this.id;
                }

                if (util.hasOwnProp.call(obj, 'created') && obj.created) {
                    obj.created = {};
                    keys = Object.keys(this.created).sort();
                    for (i = 0; i < keys.length; i += 1) {
                        obj.created[keys[i]] = {value: this.created[keys[i]].raw,
                                                version: this.created[keys[i]].version};
                    }
                }

                if (util.hasOwnProp.call(obj, 'read') && obj.read) {
                    obj.read = {};
                    seen = {};
                    worklist = [this.read].concat(this.readStack);
                    while (worklist.length !== 0) {
                        value = worklist.shift();
                        keys = Object.keys(value).sort();
                        for (i = 0; i < keys.length; i += 1) {
                            if (! util.hasOwnProp.call(seen, keys[i])) {
                                seen[keys[i]] = true;
                                if (util.hasOwnProp.call(obj, 'created') ||
                                    ! util.hasOwnProp.call(this.created, keys[i])) {
                                    obj.read[keys[i]] = {version: this.read[keys[i]]};
                                }
                            }
                        }
                    }
                }

                if (util.hasOwnProp.call(obj, 'written') && obj.written) {
                    obj.written = {};
                    keys = Object.keys(this.written).sort();
                    for (i = 0; i < keys.length; i += 1) {
                        parent = {children: {},
                                  version: this.written[keys[i]].tvar.version};
                        obj.written[keys[i]] = parent;
                        names = Object.keys(this.written[keys[i]].children);
                        for (j = 0; j < names.length; j += 1) {
                            value = this.written[keys[i]].children[names[j]];
                            if (util.isPrimitive(value)) {
                                parent.children[names[j]] = {primitive: value};
                            } else if (this.deleted === value) {
                                parent.children[names[j]] = {deleted: true};
                            } else {
                                parent.children[names[j]] = {tvar: this.stm.asTVar(value).id};
                            }
                        }
                    }
                }

                return obj;
            }
        };


        STM = function () {
            this.tVarCount = 0;
            this.txnCount = 0;
            this.transactionFrame = undefined;

            this.objToTVar = new WeakMap();
            this.proxiedToTVar = new WeakMap();
            this.idToTVar = {};
            this.retryException = {};
            this.server.stm = this;
            this.root();
        };

        STM.prototype = {
            logging: false,

            log: function (msgs) {
                var str;
                if (this.logging) {
                    if (typeof msgs === "string") {
                        console.log(msgs);
                    } else if (undefined === msgs.join) {
                        console.log(msgs);
                    } else {
                        console.log(msgs.join(""));
                    }
                }
            },

            server: {
                commit: function (txnLog, success, failure) {
                    this.stm.log("Committing txn log:");
                    this.stm.log(txnLog);
                    return success();
                },

                retry: function (txnLog, restart) {
                    // default implementation is just going to spin on
                    // this for the time being.
                    this.stm.log("Retry with txn log:");
                    this.stm.log(txnLog);
                    return restart();
                }
            },

            inTransaction: function () {
                return this.transactionFrame !== undefined;
            },

            orElse: function (funs, cont, parent) {
                var txn;
                if (undefined === parent) {
                    parent = this.transactionFrame;
                }
                this.txnCount += 1;
                txn = new Transaction(this, this.txnCount, parent, funs, cont);
                return txn.run();
            },

            atomically: function (fun, cont) {
                return this.orElse([fun], cont);
            },

            retry: function () {
                if (!this.inTransaction()) {
                    throw new RetryOutsideTransactionException();
                }
                this.transactionFrame.retry();
            },

            recordRead: function (parent) {
                if (this.inTransaction()) {
                    this.transactionFrame.recordRead(parent);
                }
            },

            recordCreation: function (value) {
                if (this.inTransaction()) {
                    this.transactionFrame.recordCreation(value);
                } else {
                    var self = this;
                    self.atomically(function () {
                        self.transactionFrame.recordCreation(value);
                    });
                }
            },

            isProxied: function (obj) {
                return this.proxiedToTVar.has(obj);
            },

            asTVar: function (proxied) {
                return this.proxiedToTVar.get(proxied);
            },

            // always returns a TVar; not a proxied obj
            ensureTVar: function (obj) {
                var val, parentId;
                if (undefined === obj || util.isPrimitive(obj)) {
                    return {proxied: obj, raw: obj};
                }
                val = this.proxiedToTVar.get(obj);
                if (undefined === val) {
                    val = this.objToTVar.get(obj);
                    if (undefined === val) {
                        this.tVarCount += 1;
                        val = new TVar(this.tVarCount, obj, this);
                        this.proxiedToTVar.set(val.proxied, val);
                        this.objToTVar.set(obj, val);
                        this.idToTVar[val.id] = val;
                        this.recordCreation(val);
                        return val;
                    } else {
                        // found it in the cache
                        return val;
                    }
                } else {
                    // obj was already proxied
                    return val;
                }
            },

            lift: function (obj) {
                return this.ensureTVar(obj).proxied;
            },

            root: function () {
                var obj, val;
                if (0 === this.tVarCount) {
                    obj = {};
                    this.tVarCount += 1;
                    val = new TVar(this.tVarCount, obj, this);
                    this.proxiedToTVar.set(val.proxied, val);
                    this.objToTVar.set(obj, val);
                    this.idToTVar[val.id] = val;
                    val.version = 1;
                    return val.proxied;
                } else {
                    return this.idToTVar[1].proxied;
                }
            },

            applyUpdates: function (updates) {
                var keys, names, update, tvar, i, j, value, obj;
                keys = Object.keys(updates);
                for (i = 0; i < keys.length; i += 1) {
                    update = updates[keys[i]];
                    tvar = this.idToTVar[keys[i]];
                    if (undefined === tvar) {
                        if (update.value.constructor === Array) {
                            obj = [];
                        } else {
                            obj = {};
                        }
                        tvar = new TVar(keys[i], obj, this);
                        this.proxiedToTVar.set(tvar.proxied, tvar);
                        this.objToTVar.set(obj, tvar);
                        this.idToTVar[tvar.id] = tvar;
                    }

                    // It's possible to see an update for a var with
                    // the same version as we already have due to
                    // multiple txns being rejected for the same
                    // reason (or a retry and commit from the same
                    // client - the commit may alter the var the retry
                    // is watching and thus prompt an update after the
                    // commit completes). If the versions are equal,
                    // then just ignore it.

                    if (tvar.version > update.version) {
                        console.error("Invalid update detected: " + tvar.id +
                                      " local vsn: " + tvar.version + "; remote vsn: " + update.version);
                    }
                    if (tvar.version === update.version) {
                        continue;
                    }

                    tvar.version = update.version;

                    names = Object.keys(tvar.raw);
                    for (j = 0; j < names.length; j += 1) {
                        if (! util.hasOwnProp(update.value, names[j])) {
                            delete tvar.raw[names[j]];
                        }
                    }

                    if (tvar.raw.constructor === Array) {
                        for (j = 0; j < update.value.length; j += 1) {
                            this.applyUpdate(tvar, j, update.value[j], updates);
                        }
                    } else {
                        names = Object.keys(update.value);
                        for (j = 0; j < names.length; j += 1) {
                            this.applyUpdate(tvar, names[j], update.value[names[j]], updates);
                        }
                    }
                }
            },

            applyUpdate: function (tvar, name, value, updates) {
                var obj, tvar2;
                if (undefined !== value.primitive) {
                    tvar.raw[name] = value.primitive;
                } else if (undefined !== value.tvar) {
                    if (undefined === this.idToTVar[value.tvar]) {
                        if (util.hasOwnProp.call(updates, value.tvar)) {
                            // we're going to create a new empty var
                            // so that we can proceed here.
                            if (updates[value.tvar].value.constructor === Array) {
                                obj = [];
                            } else {
                                obj = {};
                            }
                            tvar2 = new TVar(value.tvar, obj, this);
                            this.proxiedToTVar.set(tvar2.proxied, tvar2);
                            this.objToTVar.set(obj, tvar2);
                            this.idToTVar[tvar2.id] = tvar2;
                        } else {
                            throw new InternalException();
                        }
                    }
                    tvar.raw[name] = this.idToTVar[value.tvar].proxied;
                }
            }
        };

    }());

    (function () {
        var p  = {
            logging: function (bool) {
                this.stm.logging = bool;
            },

            inTransaction: function () {
                return this.stm.inTransaction();
            },

            orElse: function (alternatives, continuation) {
                return this.stm.orElse(alternatives, continuation);
            },

            atomically: function (fun, continuation) {
                return this.stm.atomically(fun, continuation);
            },

            retry: function () {
                return this.stm.retry();
            },

            lift: function (value) {
                return this.stm.lift(value);
            }
        };

        if (typeof exports !== "undefined") {
            // we're in node

            Atomize = function (Client) {
                var conn, inflight, stm, client;

                inflight = {};

                this.stm = new STM();
                stm = this.stm;

                conn = { id: "server",

                         write: function (msg) {
                             // this is the server writing a message
                             // back to the client.

                             var txnLog, txnId, txn;
                             txnLog = Cereal.parse(msg);
                             switch (txnLog.type) {
                             case "commit":
                                 txnId = txnLog.txnId;
                                 txn = inflight[txnId];
                                 delete inflight[txnId];
                                 if (txnLog.result === "success") {
                                     txn.success();
                                 } else {
                                     txn.failure();
                                 }
                                 break;
                             case "retry":
                                 txnId = txnLog.txnId;
                                 txn = inflight[txnId];
                                 delete inflight[txnId];
                                 txn.restart();
                                 break;
                             case "updates":
                                 stm.log("Received Updates:");
                                 stm.log(txnLog);
                                 stm.applyUpdates(txnLog.updates);
                                 break;
                             default:
                                 stm.log("Confused");
                             }
                         }
                       };

                client = new Client(conn);

                stm.server.commit = function (txnLog, success, failure) {
                    var obj;
                    obj = {txnLog: txnLog, success: success, failure: failure};
                    stm.log(["[Txn ", txnLog.txnId, "] sending commit"]);
                    stm.log(txnLog);
                    inflight[txnLog.txnId] = obj;
                    client.dispatch(Cereal.stringify(txnLog));
                };

                stm.server.retry = function (txnLog, restart) {
                    var obj;
                    obj = {txnLog: txnLog, restart: restart};
                    stm.log(["[Txn ", txnLog.txnId, "] sending retry"]);
                    stm.log(txnLog);
                    inflight[txnLog.txnId] = obj;
                    client.dispatch(Cereal.stringify(txnLog));
                };


                this.root = this.stm.root();
            };

            exports.Atomize = Atomize;

        } else if (undefined === window.SockJS) {
            console.warn("SockJS not found. Assuming offline-mode.");

            Atomize = function () {
                this.stm = new STM();
                this.root = this.stm.root();
            };

        } else {
            Atomize = function (url) {
                var stm, sockjs, commit_inflight, commit_queue, retry_inflight, retry_queue, ready;

                this.stm = new STM();

                if (undefined === url) {
                    console.warn("No url provided. Assuming offline-mode.");

                } else {
                    commit_inflight = {};
                    commit_queue = [];

                    retry_inflight = {};
                    retry_queue = [];

                    ready = false;

                    sockjs = new SockJS(url);

                    stm = this.stm;

                    sockjs.onopen = function () {
                        var i, obj;
                        stm.log(["Connected to server ", url, " (using ", sockjs.protocol, ")"]);
                        ready = true;
                        for (i = 0; i < commit_queue.length; i += 1) {
                            obj = commit_queue[i];
                            stm.server.commit(obj.txnLog, obj.success, obj.failure);
                        }
                        commit_queue = [];
                        for (i = 0; i < retry_queue.length; i += 1) {
                            obj = retry_queue[i];
                            stm.server.retry(obj.txnLog, obj.onchange);
                        }
                        retry_queue = [];
                    };

                    sockjs.onclose = function (e) {
                        var keys, i, obj;
                        stm.log(["Disconnected from server ", url, " (", e.status, " ", e.reason, ")"]);
                        ready = false;
                        keys = Object.keys(commit_inflight).sort();
                        for (i = 0; i < keys.length; i += 1) {
                            commit_queue.push(commit_inflight[keys[i]]);
                        }
                        commit_inflight = {};
                        keys = Object.keys(retry_inflight).sort();
                        for (i = 0; i < keys.length; i += 1) {
                            retry_queue.push(retry_inflight[keys[i]]);
                        }
                        retry_inflight = {};
                    };

                    sockjs.onmessage = function (e) {
                        var txnLog, txnId, txn;
                        txnLog = Cereal.parse(e.data);
                        switch (txnLog.type) {
                        case "commit":
                            txnId = txnLog.txnId;
                            txn = commit_inflight[txnId];
                            delete commit_inflight[txnId];
                            stm.log(["[Txn ", txnId, "] commit response received: ", txnLog.result]);
                            if (txnLog.result === "success") {
                                txn.success();
                            } else {
                                txn.failure();
                            }
                            break;
                        case "retry":
                            txnId = txnLog.txnId;
                            txn = retry_inflight[txnId];
                            delete retry_inflight[txnId];
                            stm.log(["[Txn ", txnId, "] retry response received."]);
                            txn.restart();
                            break;
                        case "updates":
                            stm.log("Received Updates:");
                            stm.log(txnLog);
                            stm.applyUpdates(txnLog.updates);
                            break;
                        default:
                            stm.log("Received unexpected message from server:");
                            stm.log(txnLog);
                        }
                    };

                    stm.server.commit = function (txnLog, success, failure) {
                        var obj;
                        obj = {txnLog: txnLog, success: success, failure: failure};
                        if (! ready) {
                            commit_queue.push(obj);
                            return;
                        }
                        stm.log(["[Txn ", txnLog.txnId, "] sending commit"]);
                        stm.log(txnLog);
                        commit_inflight[txnLog.txnId] = obj;
                        sockjs.send(Cereal.stringify(txnLog));
                    };

                    stm.server.retry = function (txnLog, restart) {
                        var obj;
                        obj = {txnLog: txnLog, restart: restart};
                        if (! ready) {
                            retry_queue.push(obj);
                            return;
                        }
                        stm.log(["[Txn ", txnLog.txnId, "] sending retry"]);
                        stm.log(txnLog);
                        retry_inflight[txnLog.txnId] = obj;
                        sockjs.send(Cereal.stringify(txnLog));
                    };
                }

                this.root = this.stm.root();
            };
        }

        Atomize.prototype = p;

    }());

}(this));