(function(undefined) {
  // The Opal object that is exposed globally
  var Opal = this.Opal = {};

  // The actual class for BasicObject
  var RubyBasicObject;

  // The actual Object class
  var RubyObject;

  // The actual Module class
  var RubyModule;

  // The actual Class class
  var RubyClass;

  // Constructor for instances of BasicObject
  function BasicObject(){}

  // Constructor for instances of Object
  function Object(){}

  // Constructor for instances of Class
  function Class(){}

  // Constructor for instances of Module
  function Module(){}

  // Constructor for instances of NilClass (nil)
  function NilClass(){}

  // All bridged classes - keep track to donate methods from Object
  var bridged_classes = [];

  // TopScope is used for inheriting constants from the top scope
  var TopScope = function(){};

  // Opal just acts as the top scope
  TopScope.prototype = Opal;

  // To inherit scopes
  Opal.constructor  = TopScope;

  Opal.constants = [];

  // This is a useful reference to global object inside ruby files
  Opal.global = this;

  // Minify common function calls
  var $hasOwn = Opal.hasOwnProperty;
  var $slice  = Opal.slice = Array.prototype.slice;

  // Generates unique id for every ruby object
  var unique_id = 0;

  // Return next unique id
  Opal.uid = function() {
    return unique_id++;
  };

  // Table holds all class variables
  Opal.cvars = {};

  // Globals table
  Opal.gvars = {};

  /*
   * Create a new constants scope for the given class with the given
   * base. Constants are looked up through their parents, so the base
   * scope will be the outer scope of the new klass.
   */
  function create_scope(base, klass, id) {
    var const_alloc   = function() {};
    var const_scope   = const_alloc.prototype = new base.constructor();
    klass._scope      = const_scope;
    const_scope.base  = klass;
    klass._base_module = base.base;
    const_scope.constructor = const_alloc;
    const_scope.constants = [];

    if (id) {
      klass._orig_scope = base;
      base[id] = base.constructor[id] = klass;
      base.constants.push(id);
    }
  }

  Opal.create_scope = create_scope;

  /*
   * A `class Foo; end` expression in ruby is compiled to call this runtime
   * method which either returns an existing class of the given name, or creates
   * a new class in the given `base` scope.
   *
   * If a constant with the given name exists, then we check to make sure that
   * it is a class and also that the superclasses match. If either of these
   * fail, then we raise a `TypeError`. Note, superklass may be null if one was
   * not specified in the ruby code.
   *
   * We pass a constructor to this method of the form `function ClassName() {}`
   * simply so that classes show up with nicely formatted names inside debuggers
   * in the web browser (or node/sprockets).
   *
   * The `base` is the current `self` value where the class is being created
   * from. We use this to get the scope for where the class should be created.
   * If `base` is an object (not a class/module), we simple get its class and
   * use that as the base instead.
   *
   * @param [Object] base where the class is being created
   * @param [Class] superklass superclass of the new class (may be null)
   * @param [String] id the name of the class to be created
   * @param [Function] constructor function to use as constructor
   * @return [Class] new or existing ruby class
   */
  Opal.klass = function(base, superklass, id, constructor) {

    // If base is an object, use its class
    if (!base._isClass) {
      base = base._klass;
    }

    // Not specifying a superclass means we can assume it to be Object
    if (superklass === null) {
      superklass = RubyObject;
    }

    var klass = base._scope[id];

    // If a constant exists in the scope, then we must use that
    if ($hasOwn.call(base._scope, id) && klass._orig_scope === base._scope) {

      // Make sure the existing constant is a class, or raise error
      if (!klass._isClass) {
        throw Opal.TypeError.$new(id + " is not a class");
      }

      // Make sure existing class has same superclass
      if (superklass !== klass._super && superklass !== RubyObject) {
        throw Opal.TypeError.$new("superclass mismatch for class " + id);
      }
    }
    else if (typeof(superklass) === 'function') {
      // passed native constructor as superklass, so bridge it as ruby class
      return bridge_class(id, superklass);
    }
    else {
      // if class doesnt exist, create a new one with given superclass
      klass = boot_class(superklass, constructor);

      // name class using base (e.g. Foo or Foo::Baz)
      klass._name = id;

      // every class gets its own constant scope, inherited from current scope
      create_scope(base._scope, klass, id);

      // Name new class directly onto current scope (Opal.Foo.Baz = klass)
      base[id] = base._scope[id] = klass;

      // Copy all parent constants to child, unless parent is Object
      if (superklass !== RubyObject && superklass !== RubyBasicObject) {
        Opal.donate_constants(superklass, klass);
      }

      // call .inherited() hook with new class on the superclass
      if (superklass.$inherited) {
        superklass.$inherited(klass);
      }
    }

    return klass;
  };

  // Create generic class with given superclass.
  var boot_class = Opal.boot = function(superklass, constructor) {
    // instances
    var ctor = function() {};
        ctor.prototype = superklass._proto;

    constructor.prototype = new ctor();

    constructor.prototype.constructor = constructor;

    return boot_class_meta(superklass, constructor);
  };

  // class itself
  function boot_class_meta(superklass, constructor) {
    var mtor = function() {};
    mtor.prototype = superklass.constructor.prototype;

    function OpalClass() {};
    OpalClass.prototype = new mtor();

    var klass = new OpalClass();

    klass._id         = unique_id++;
    klass._alloc      = constructor;
    klass._isClass    = true;
    klass.constructor = OpalClass;
    klass._super      = superklass;
    klass._methods    = [];
    klass.__inc__     = [];
    klass.__parent    = superklass;
    klass._proto      = constructor.prototype;

    constructor.prototype._klass = klass;

    return klass;
  }

  // Define new module (or return existing module)
  Opal.module = function(base, id) {
    var module;

    if (!base._isClass) {
      base = base._klass;
    }

    if ($hasOwn.call(base._scope, id)) {
      module = base._scope[id];

      if (!module.__mod__ && module !== RubyObject) {
        throw Opal.TypeError.$new(id + " is not a module")
      }
    }
    else {
      module = boot_module()
      module._name = id;

      create_scope(base._scope, module, id);

      // Name new module directly onto current scope (Opal.Foo.Baz = module)
      base[id] = base._scope[id] = module;
    }

    return module;
  };

  /*
   * Internal function to create a new module instance. This simply sets up
   * the prototype hierarchy and method tables.
   */
  function boot_module() {
    var mtor = function() {};
    mtor.prototype = RubyModule.constructor.prototype;

    function OpalModule() {};
    OpalModule.prototype = new mtor();

    var module = new OpalModule();

    module._id         = unique_id++;
    module._isClass    = true;
    module.constructor = OpalModule;
    module._super      = RubyModule;
    module._methods    = [];
    module.__inc__     = [];
    module.__parent    = RubyModule;
    module._proto      = {};
    module.__mod__     = true;
    module.__dep__     = [];

    return module;
  }

  // Boot a base class (makes instances).
  var boot_defclass = function(id, constructor, superklass) {
    if (superklass) {
      var ctor           = function() {};
          ctor.prototype = superklass.prototype;

      constructor.prototype = new ctor();
    }

    constructor.prototype.constructor = constructor;

    return constructor;
  };

  // Boot the actual (meta?) classes of core classes
  var boot_makemeta = function(id, constructor, superklass) {

    var mtor = function() {};
    mtor.prototype  = superklass.prototype;

    function OpalClass() {};
    OpalClass.prototype = new mtor();

    var klass = new OpalClass();

    klass._id         = unique_id++;
    klass._alloc      = constructor;
    klass._isClass    = true;
    klass._name       = id;
    klass._super      = superklass;
    klass.constructor = OpalClass;
    klass._methods    = [];
    klass.__inc__     = [];
    klass.__parent    = superklass;
    klass._proto      = constructor.prototype;

    constructor.prototype._klass = klass;

    Opal[id] = klass;
    Opal.constants.push(id);

    return klass;
  };

  /*
   * For performance, some core ruby classes are toll-free bridged to their
   * native javascript counterparts (e.g. a ruby Array is a javascript Array).
   *
   * This method is used to setup a native constructor (e.g. Array), to have
   * its prototype act like a normal ruby class. Firstly, a new ruby class is
   * created using the native constructor so that its prototype is set as the
   * target for th new class. Note: all bridged classes are set to inherit
   * from Object.
   *
   * Bridged classes are tracked in `bridged_classes` array so that methods
   * defined on Object can be "donated" to all bridged classes. This allows
   * us to fake the inheritance of a native prototype from our Object
   * prototype.
   *
   * Example:
   *
   *    bridge_class("Proc", Function);
   *
   * @param [String] name the name of the ruby class to create
   * @param [Function] constructor native javascript constructor to use
   * @return [Class] returns new ruby class
   */
  function bridge_class(name, constructor) {
    var klass = boot_class_meta(RubyObject, constructor);

    klass._name = name;

    create_scope(Opal, klass, name);
    bridged_classes.push(klass);

    var object_methods = RubyBasicObject._methods.concat(RubyObject._methods);

    for (var i = 0, len = object_methods.length; i < len; i++) {
      var meth = object_methods[i];
      constructor.prototype[meth] = RubyObject._proto[meth];
    }

    return klass;
  };

  /*
   * constant assign
   */
  Opal.casgn = function(base_module, name, value) {
    var scope = base_module._scope;

    if (value._isClass && value._name === nil) {
      value._name = name;
    }

    if (value._isClass) {
      value._base_module = base_module;
    }

    scope.constants.push(name);
    return scope[name] = value;
  };

  /*
   * constant decl
   */
  Opal.cdecl = function(base_scope, name, value) {
    base_scope.constants.push(name);
    return base_scope[name] = value;
  };

  /*
   * constant get
   */
  Opal.cget = function(base_scope, path) {
    if (path == null) {
      path       = base_scope;
      base_scope = Opal.Object;
    }

    var result = base_scope;

    path = path.split('::');
    while (path.length != 0) {
      result = result.$const_get(path.shift());
    }

    return result;
  }

  /*
   * When a source module is included into the target module, we must also copy
   * its constants to the target.
   */
  Opal.donate_constants = function(source_mod, target_mod) {
    var source_constants = source_mod._scope.constants,
        target_scope     = target_mod._scope,
        target_constants = target_scope.constants;

    for (var i = 0, length = source_constants.length; i < length; i++) {
      target_constants.push(source_constants[i]);
      target_scope[source_constants[i]] = source_mod._scope[source_constants[i]];
    }
  };

  /*
   * Methods stubs are used to facilitate method_missing in opal. A stub is a
   * placeholder function which just calls `method_missing` on the receiver.
   * If no method with the given name is actually defined on an object, then it
   * is obvious to say that the stub will be called instead, and then in turn
   * method_missing will be called.
   *
   * When a file in ruby gets compiled to javascript, it includes a call to
   * this function which adds stubs for every method name in the compiled file.
   * It should then be safe to assume that method_missing will work for any
   * method call detected.
   *
   * Method stubs are added to the BasicObject prototype, which every other
   * ruby object inherits, so all objects should handle method missing. A stub
   * is only added if the given property name (method name) is not already
   * defined.
   *
   * Note: all ruby methods have a `$` prefix in javascript, so all stubs will
   * have this prefix as well (to make this method more performant).
   *
   *    Opal.add_stubs(["$foo", "$bar", "$baz="]);
   *
   * All stub functions will have a private `rb_stub` property set to true so
   * that other internal methods can detect if a method is just a stub or not.
   * `Kernel#respond_to?` uses this property to detect a methods presence.
   *
   * @param [Array] stubs an array of method stubs to add
   */
  Opal.add_stubs = function(stubs) {
    for (var i = 0, length = stubs.length; i < length; i++) {
      var stub = stubs[i];

      if (!BasicObject.prototype[stub]) {
        BasicObject.prototype[stub] = true;
        add_stub_for(BasicObject.prototype, stub);
      }
    }
  };

  /*
   * Actuall add a method_missing stub function to the given prototype for the
   * given name.
   *
   * @param [Prototype] prototype the target prototype
   * @param [String] stub stub name to add (e.g. "$foo")
   */
  function add_stub_for(prototype, stub) {
    function method_missing_stub() {
      // Copy any given block onto the method_missing dispatcher
      this.$method_missing._p = method_missing_stub._p;

      // Set block property to null ready for the next call (stop false-positives)
      method_missing_stub._p = null;

      // call method missing with correct args (remove '$' prefix on method name)
      return this.$method_missing.apply(this, [stub.slice(1)].concat($slice.call(arguments)));
    }

    method_missing_stub.rb_stub = true;
    prototype[stub] = method_missing_stub;
  }

  // Expose for other parts of Opal to use
  Opal.add_stub_for = add_stub_for;

  // Const missing dispatcher
  Opal.cm = function(name) {
    return this.base.$const_missing(name);
  };

  // Arity count error dispatcher
  Opal.ac = function(actual, expected, object, meth) {
    var inspect = (object._isClass ? object._name + '.' : object._klass._name + '#') + meth;
    var msg = '[' + inspect + '] wrong number of arguments(' + actual + ' for ' + expected + ')';
    throw Opal.ArgumentError.$new(msg);
  };

  // Super dispatcher
  Opal.find_super_dispatcher = function(obj, jsid, current_func, iter, defs) {
    var dispatcher;

    if (defs) {
      dispatcher = obj._isClass ? defs._super : obj._klass._proto;
    }
    else {
      if (obj._isClass) {
        dispatcher = obj._super;
      }
      else {
        dispatcher = find_obj_super_dispatcher(obj, jsid, current_func);
      }
    }

    dispatcher = dispatcher['$' + jsid];
    dispatcher._p = iter;

    return dispatcher;
  };

  // Iter dispatcher for super in a block
  Opal.find_iter_super_dispatcher = function(obj, jsid, current_func, iter, defs) {
    if (current_func._def) {
      return Opal.find_super_dispatcher(obj, current_func._jsid, current_func, iter, defs);
    }
    else {
      return Opal.find_super_dispatcher(obj, jsid, current_func, iter, defs);
    }
  };

  var find_obj_super_dispatcher = function(obj, jsid, current_func) {
    var klass = obj.__meta__ || obj._klass;

    while (klass) {
      if (klass._proto['$' + jsid] === current_func) {
        // ok
        break;
      }

      klass = klass.__parent;
    }

    // if we arent in a class, we couldnt find current?
    if (!klass) {
      throw new Error("could not find current class for super()");
    }

    klass = klass.__parent;

    // else, let's find the next one
    while (klass) {
      var working = klass._proto['$' + jsid];

      if (working && working !== current_func) {
        // ok
        break;
      }

      klass = klass.__parent;
    }

    return klass._proto;
  };

  /*
   * Used to return as an expression. Sometimes, we can't simply return from
   * a javascript function as if we were a method, as the return is used as
   * an expression, or even inside a block which must "return" to the outer
   * method. This helper simply throws an error which is then caught by the
   * method. This approach is expensive, so it is only used when absolutely
   * needed.
   */
  Opal.$return = function(val) {
    Opal.returner.$v = val;
    throw Opal.returner;
  };

  // handles yield calls for 1 yielded arg
  Opal.$yield1 = function(block, arg) {
    if (typeof(block) !== "function") {
      throw Opal.LocalJumpError.$new("no block given");
    }

    if (block.length > 1) {
      if (arg._isArray) {
        return block.apply(null, arg);
      }
      else {
        return block(arg);
      }
    }
    else {
      return block(arg);
    }
  };

  // handles yield for > 1 yielded arg
  Opal.$yieldX = function(block, args) {
    if (typeof(block) !== "function") {
      throw Opal.LocalJumpError.$new("no block given");
    }

    if (block.length > 1 && args.length == 1) {
      if (args[0]._isArray) {
        return block.apply(null, args[0]);
      }
    }

    if (!args._isArray) {
      args = $slice.call(args);
    }

    return block.apply(null, args);
  };

  // Finds the corresponding exception match in candidates.  Each candidate can
  // be a value, or an array of values.  Returns null if not found.
  Opal.$rescue = function(exception, candidates) {
    for (var i = 0; i != candidates.length; i++) {
      var candidate = candidates[i];
      if (candidate._isArray) {
        var subresult;
        if (subresult = Opal.$rescue(exception, candidate)) {
          return subresult;
        }
      }
      else if (candidate['$==='](exception)) {
        return candidate;
      }
    }
    return null;
  };

  Opal.is_a = function(object, klass) {
    if (object.__meta__ === klass) {
      return true;
    }

    var search = object._klass;

    while (search) {
      if (search === klass) {
        return true;
      }

      for (var i = 0, length = search.__inc__.length; i < length; i++) {
        if (search.__inc__[i] == klass) {
          return true;
        }
      }

      search = search._super;
    }

    return false;
  }

  // Helper to convert the given object to an array
  Opal.to_ary = function(value) {
    if (value._isArray) {
      return value;
    }
    else if (value.$to_ary && !value.$to_ary.rb_stub) {
      return value.$to_ary();
    }

    return [value];
  };

  /*
    Call a ruby method on a ruby object with some arguments:

      var my_array = [1, 2, 3, 4]
      Opal.send(my_array, 'length')     # => 4
      Opal.send(my_array, 'reverse!')   # => [4, 3, 2, 1]

    A missing method will be forwarded to the object via
    method_missing.

    The result of either call with be returned.

    @param [Object] recv the ruby object
    @param [String] mid ruby method to call
  */
  Opal.send = function(recv, mid) {
    var args = $slice.call(arguments, 2),
        func = recv['$' + mid];

    if (func) {
      return func.apply(recv, args);
    }

    return recv.$method_missing.apply(recv, [mid].concat(args));
  };

  Opal.block_send = function(recv, mid, block) {
    var args = $slice.call(arguments, 3),
        func = recv['$' + mid];

    if (func) {
      func._p = block;
      return func.apply(recv, args);
    }

    return recv.$method_missing.apply(recv, [mid].concat(args));
  };

  /**
   * Donate methods for a class/module
   */
  Opal.donate = function(klass, defined, indirect) {
    var methods = klass._methods, included_in = klass.__dep__;

    // if (!indirect) {
      klass._methods = methods.concat(defined);
    // }

    if (included_in) {
      for (var i = 0, length = included_in.length; i < length; i++) {
        var includee = included_in[i];
        var dest = includee._proto;

        for (var j = 0, jj = defined.length; j < jj; j++) {
          var method = defined[j];
          dest[method] = klass._proto[method];
          dest[method]._donated = true;
        }

        if (includee.__dep__) {
          Opal.donate(includee, defined, true);
        }
      }
    }
  };

  Opal.defn = function(obj, jsid, body) {
    if (obj.__mod__) {
      obj._proto[jsid] = body;
      Opal.donate(obj, [jsid]);
    }
    else if (obj._isClass) {
      obj._proto[jsid] = body;

      if (obj === RubyBasicObject) {
        define_basic_object_method(jsid, body);
      }
      else if (obj === RubyObject) {
        Opal.donate(obj, [jsid]);
      }
    }
    else {
      obj[jsid] = body;
    }

    return nil;
  };

  /*
   * Define a singleton method on the given object.
   */
  Opal.defs = function(obj, jsid, body) {
    if (obj._isClass || obj.__mod__) {
      obj.constructor.prototype[jsid] = body;
    }
    else {
      obj[jsid] = body;
    }
  };

  function define_basic_object_method(jsid, body) {
    RubyBasicObject._methods.push(jsid);
    for (var i = 0, len = bridged_classes.length; i < len; i++) {
      bridged_classes[i]._proto[jsid] = body;
    }
  }

  Opal.hash = function() {
    if (arguments.length == 1 && arguments[0]._klass == Opal.Hash) {
      return arguments[0];
    }

    var hash   = new Opal.Hash._alloc,
        keys   = [],
        assocs = {};

    hash.map   = assocs;
    hash.keys  = keys;

    if (arguments.length == 1) {
      if (arguments[0]._isArray) {
        var args = arguments[0];

        for (var i = 0, length = args.length; i < length; i++) {
          var pair = args[i];

          if (pair.length !== 2) {
            throw Opal.ArgumentError.$new("value not of length 2: " + pair.$inspect());
          }

          var key = pair[0],
              obj = pair[1];

          if (assocs[key] == null) {
            keys.push(key);
          }

          assocs[key] = obj;
        }
      }
      else {
        var obj = arguments[0];
        for (var key in obj) {
          assocs[key] = obj[key];
          keys.push(key);
        }
      }
    }
    else {
      var length = arguments.length;
      if (length % 2 !== 0) {
        throw Opal.ArgumentError.$new("odd number of arguments for Hash");
      }

      for (var i = 0; i < length; i++) {
        var key = arguments[i],
            obj = arguments[++i];

        if (assocs[key] == null) {
          keys.push(key);
        }

        assocs[key] = obj;
      }
    }

    return hash;
  };

  /*
   * hash2 is a faster creator for hashes that just use symbols and
   * strings as keys. The map and keys array can be constructed at
   * compile time, so they are just added here by the constructor
   * function
   */
  Opal.hash2 = function(keys, map) {
    var hash = new Opal.Hash._alloc;

    hash.keys = keys;
    hash.map  = map;

    return hash;
  };

  /*
   * Create a new range instance with first and last values, and whether the
   * range excludes the last value.
   */
  Opal.range = function(first, last, exc) {
    var range         = new Opal.Range._alloc;
        range.begin   = first;
        range.end     = last;
        range.exclude = exc;

    return range;
  };

  // Initialization
  // --------------

  // Constructors for *instances* of core objects
  boot_defclass('BasicObject', BasicObject);
  boot_defclass('Object', Object, BasicObject);
  boot_defclass('Module', Module, Object);
  boot_defclass('Class', Class, Module);

  // Constructors for *classes* of core objects
  RubyBasicObject = boot_makemeta('BasicObject', BasicObject, Class);
  RubyObject      = boot_makemeta('Object', Object, RubyBasicObject.constructor);
  RubyModule      = boot_makemeta('Module', Module, RubyObject.constructor);
  RubyClass       = boot_makemeta('Class', Class, RubyModule.constructor);

  // Fix booted classes to use their metaclass
  RubyBasicObject._klass = RubyClass;
  RubyObject._klass = RubyClass;
  RubyModule._klass = RubyClass;
  RubyClass._klass = RubyClass;

  // Fix superclasses of booted classes
  RubyBasicObject._super = null;
  RubyObject._super = RubyBasicObject;
  RubyModule._super = RubyObject;
  RubyClass._super = RubyModule;

  // Internally, Object acts like a module as it is "included" into bridged
  // classes. In other words, we donate methods from Object into our bridged
  // classes as their prototypes don't inherit from our root Object, so they
  // act like module includes.
  RubyObject.__dep__ = bridged_classes;

  Opal.base = RubyObject;
  RubyBasicObject._scope = RubyObject._scope = Opal;
  RubyBasicObject._orig_scope = RubyObject._orig_scope = Opal;
  Opal.Kernel = RubyObject;

  RubyModule._scope = RubyObject._scope;
  RubyClass._scope = RubyObject._scope;
  RubyModule._orig_scope = RubyObject._orig_scope;
  RubyClass._orig_scope = RubyObject._orig_scope;

  RubyObject._proto.toString = function() {
    return this.$to_s();
  };

  Opal.top = new RubyObject._alloc();

  Opal.klass(RubyObject, RubyObject, 'NilClass', NilClass);

  var nil = Opal.nil = new NilClass;
  nil.call = nil.apply = function() { throw Opal.LocalJumpError.$new('no block given'); };

  Opal.breaker  = new Error('unexpected break');
  Opal.returner = new Error('unexpected return');

  bridge_class('Array', Array);
  bridge_class('Boolean', Boolean);
  bridge_class('Numeric', Number);
  bridge_class('String', String);
  bridge_class('Proc', Function);
  bridge_class('Exception', Error);
  bridge_class('Regexp', RegExp);
  bridge_class('Time', Date);

  TypeError._super = Error;
}).call(this);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module;

  $opal.add_stubs(['$new', '$class', '$===', '$respond_to?', '$raise', '$type_error', '$__send__', '$coerce_to', '$nil?', '$<=>', '$name', '$inspect']);
  return (function($base) {
    var self = $module($base, 'Opal');

    var def = self._proto, $scope = self._scope;

    $opal.defs(self, '$type_error', function(object, type, method, coerced) {
      var $a, $b, self = this;

      if (method == null) {
        method = nil
      }
      if (coerced == null) {
        coerced = nil
      }
      if ((($a = (($b = method !== false && method !== nil) ? coerced : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return (($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a).$new("can't convert " + (object.$class()) + " into " + (type) + " (" + (object.$class()) + "#" + (method) + " gives " + (coerced.$class()))
        } else {
        return (($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a).$new("no implicit conversion of " + (object.$class()) + " into " + (type))
      };
    });

    $opal.defs(self, '$coerce_to', function(object, type, method) {
      var $a, self = this;

      if ((($a = type['$==='](object)) !== nil && (!$a._isBoolean || $a == true))) {
        return object};
      if ((($a = object['$respond_to?'](method)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise(self.$type_error(object, type))
      };
      return object.$__send__(method);
    });

    $opal.defs(self, '$coerce_to!', function(object, type, method) {
      var $a, self = this, coerced = nil;

      coerced = self.$coerce_to(object, type, method);
      if ((($a = type['$==='](coerced)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise(self.$type_error(object, type, method, coerced))
      };
      return coerced;
    });

    $opal.defs(self, '$coerce_to?', function(object, type, method) {
      var $a, self = this, coerced = nil;

      if ((($a = object['$respond_to?'](method)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return nil
      };
      coerced = self.$coerce_to(object, type, method);
      if ((($a = coerced['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
        return nil};
      if ((($a = type['$==='](coerced)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise(self.$type_error(object, type, method, coerced))
      };
      return coerced;
    });

    $opal.defs(self, '$try_convert', function(object, type, method) {
      var $a, self = this;

      if ((($a = type['$==='](object)) !== nil && (!$a._isBoolean || $a == true))) {
        return object};
      if ((($a = object['$respond_to?'](method)) !== nil && (!$a._isBoolean || $a == true))) {
        return object.$__send__(method)
        } else {
        return nil
      };
    });

    $opal.defs(self, '$compare', function(a, b) {
      var $a, self = this, compare = nil;

      compare = a['$<=>'](b);
      if ((($a = compare === nil) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison of " + (a.$class().$name()) + " with " + (b.$class().$name()) + " failed")};
      return compare;
    });

    $opal.defs(self, '$destructure', function(args) {
      var self = this;

      
      if (args.length == 1) {
        return args[0];
      }
      else if (args._isArray) {
        return args;
      }
      else {
        return $slice.call(args);
      }
    
    });

    $opal.defs(self, '$respond_to?', function(obj, method) {
      var self = this;

      
      if (obj == null || !obj._klass) {
        return false;
      }
    
      return obj['$respond_to?'](method);
    });

    $opal.defs(self, '$inspect', function(obj) {
      var self = this;

      
      if (obj === undefined) {
        return "undefined";
      }
      else if (obj === null) {
        return "null";
      }
      else if (!obj._klass) {
        return obj.toString();
      }
      else {
        return obj.$inspect();
      }
    
    });
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$attr_reader', '$attr_writer', '$=~', '$raise', '$const_missing', '$to_str', '$to_proc', '$append_features', '$included', '$name', '$new', '$to_s']);
  return (function($base, $super) {
    function $Module(){};
    var self = $Module = $klass($base, $super, 'Module', $Module);

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3, TMP_4;

    $opal.defs(self, '$new', TMP_1 = function() {
      var self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      
      function AnonModule(){}
      var klass     = Opal.boot(Opal.Module, AnonModule);
      klass._name   = nil;
      klass._klass  = Opal.Module;
      klass.__dep__ = []
      klass.__mod__ = true;
      klass._proto  = {};

      // inherit scope from parent
      $opal.create_scope(Opal.Module._scope, klass);

      if (block !== nil) {
        var block_self = block._s;
        block._s = null;
        block.call(klass);
        block._s = block_self;
      }

      return klass;
    
    });

    def['$==='] = function(object) {
      var $a, self = this;

      if ((($a = object == null) !== nil && (!$a._isBoolean || $a == true))) {
        return false};
      return $opal.is_a(object, self);
    };

    def['$<'] = function(other) {
      var self = this;

      
      var working = self;

      while (working) {
        if (working === other) {
          return true;
        }

        working = working.__parent;
      }

      return false;
    
    };

    def.$alias_method = function(newname, oldname) {
      var self = this;

      
      self._proto['$' + newname] = self._proto['$' + oldname];

      if (self._methods) {
        $opal.donate(self, ['$' + newname ])
      }
    
      return self;
    };

    def.$alias_native = function(mid, jsid) {
      var self = this;

      if (jsid == null) {
        jsid = mid
      }
      return self._proto['$' + mid] = self._proto[jsid];
    };

    def.$ancestors = function() {
      var self = this;

      
      var parent = self,
          result = [];

      while (parent) {
        result.push(parent);
        result = result.concat(parent.__inc__);

        parent = parent._super;
      }

      return result;
    
    };

    def.$append_features = function(klass) {
      var self = this;

      
      var module   = self,
          included = klass.__inc__;

      // check if this module is already included in the klass
      for (var i = 0, length = included.length; i < length; i++) {
        if (included[i] === module) {
          return;
        }
      }

      included.push(module);
      module.__dep__.push(klass);

      // iclass
      var iclass = {
        name: module._name,

        _proto:   module._proto,
        __parent: klass.__parent,
        __iclass: true
      };

      klass.__parent = iclass;

      var donator   = module._proto,
          prototype = klass._proto,
          methods   = module._methods;

      for (var i = 0, length = methods.length; i < length; i++) {
        var method = methods[i];

        if (prototype.hasOwnProperty(method) && !prototype[method]._donated) {
          // if the target class already has a method of the same name defined
          // and that method was NOT donated, then it must be a method defined
          // by the class so we do not want to override it
        }
        else {
          prototype[method] = donator[method];
          prototype[method]._donated = true;
        }
      }

      if (klass.__dep__) {
        $opal.donate(klass, methods.slice(), true);
      }

      $opal.donate_constants(module, klass);
    
      return self;
    };

    def.$attr_accessor = function(names) {
      var $a, $b, self = this;

      names = $slice.call(arguments, 0);
      ($a = self).$attr_reader.apply($a, [].concat(names));
      return ($b = self).$attr_writer.apply($b, [].concat(names));
    };

    def.$attr_reader = function(names) {
      var self = this;

      names = $slice.call(arguments, 0);
      
      var proto = self._proto, cls = self;
      for (var i = 0, length = names.length; i < length; i++) {
        (function(name) {
          proto[name] = nil;
          var func = function() { return this[name] };

          if (cls._isSingleton) {
            proto.constructor.prototype['$' + name] = func;
          }
          else {
            proto['$' + name] = func;
            $opal.donate(self, ['$' + name ]);
          }
        })(names[i]);
      }
    
      return nil;
    };

    def.$attr_writer = function(names) {
      var self = this;

      names = $slice.call(arguments, 0);
      
      var proto = self._proto, cls = self;
      for (var i = 0, length = names.length; i < length; i++) {
        (function(name) {
          proto[name] = nil;
          var func = function(value) { return this[name] = value; };

          if (cls._isSingleton) {
            proto.constructor.prototype['$' + name + '='] = func;
          }
          else {
            proto['$' + name + '='] = func;
            $opal.donate(self, ['$' + name + '=']);
          }
        })(names[i]);
      }
    
      return nil;
    };

    $opal.defn(self, '$attr', def.$attr_accessor);

    def.$constants = function() {
      var self = this;

      return self._scope.constants;
    };

    def['$const_defined?'] = function(name, inherit) {
      var $a, self = this;

      if (inherit == null) {
        inherit = true
      }
      if ((($a = name['$=~'](/^[A-Z]\w*$/)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.NameError) == null ? $opal.cm('NameError') : $a), "wrong constant name " + (name))
      };
      
      scopes = [self._scope];
      if (inherit || self === Opal.Object) {
        var parent = self._super;
        while (parent !== Opal.BasicObject) {
          scopes.push(parent._scope);
          parent = parent._super;
        }
      }

      for (var i = 0, len = scopes.length; i < len; i++) {
        if (scopes[i].hasOwnProperty(name)) {
          return true;
        }
      }

      return false;
    
    };

    def.$const_get = function(name, inherit) {
      var $a, self = this;

      if (inherit == null) {
        inherit = true
      }
      if ((($a = name['$=~'](/^[A-Z]\w*$/)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.NameError) == null ? $opal.cm('NameError') : $a), "wrong constant name " + (name))
      };
      
      var scopes = [self._scope];
      if (inherit || self == Opal.Object) {
        var parent = self._super;
        while (parent !== Opal.BasicObject) {
          scopes.push(parent._scope);
          parent = parent._super;
        }
      }

      for (var i = 0, len = scopes.length; i < len; i++) {
        if (scopes[i].hasOwnProperty(name)) {
          return scopes[i][name];
        }
      }

      return self.$const_missing(name);
    
    };

    def.$const_missing = function(const$) {
      var $a, self = this, name = nil;

      name = self._name;
      return self.$raise((($a = $scope.NameError) == null ? $opal.cm('NameError') : $a), "uninitialized constant " + (name) + "::" + (const$));
    };

    def.$const_set = function(name, value) {
      var $a, self = this;

      if ((($a = name['$=~'](/^[A-Z]\w*$/)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.NameError) == null ? $opal.cm('NameError') : $a), "wrong constant name " + (name))
      };
      try {
      name = name.$to_str()
      } catch ($err) {if (true) {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "conversion with #to_str failed")
        }else { throw $err; }
      };
      
      $opal.casgn(self, name, value);
      return value
    ;
    };

    def.$define_method = TMP_2 = function(name, method) {
      var self = this, $iter = TMP_2._p, block = $iter || nil;

      TMP_2._p = null;
      
      if (method) {
        block = method.$to_proc();
      }

      if (block === nil) {
        throw new Error("no block given");
      }

      var jsid    = '$' + name;
      block._jsid = name;
      block._s    = null;
      block._def  = block;

      self._proto[jsid] = block;
      $opal.donate(self, [jsid]);

      return name;
    ;
    };

    def.$remove_method = function(name) {
      var self = this;

      
      var jsid    = '$' + name;
      var current = self._proto[jsid];
      delete self._proto[jsid];

      // Check if we need to reverse $opal.donate
      // $opal.retire(self, [jsid]);
      return self;
    
    };

    def.$include = function(mods) {
      var self = this;

      mods = $slice.call(arguments, 0);
      
      for (var i = mods.length - 1; i >= 0; i--) {
        var mod = mods[i];

        if (mod === self) {
          continue;
        }

        (mod).$append_features(self);
        (mod).$included(self);
      }
    
      return self;
    };

    def['$include?'] = function(mod) {
      var self = this;

      
      for (var cls = self; cls; cls = cls.parent) {
        for (var i = 0; i != cls.__inc__.length; i++) {
          var mod2 = cls.__inc__[i];
          if (mod === mod2) {
            return true;
          }
        }
      }
      return false;
    
    };

    def.$instance_method = function(name) {
      var $a, self = this;

      
      var meth = self._proto['$' + name];

      if (!meth || meth.rb_stub) {
        self.$raise((($a = $scope.NameError) == null ? $opal.cm('NameError') : $a), "undefined method `" + (name) + "' for class `" + (self.$name()) + "'");
      }

      return (($a = $scope.UnboundMethod) == null ? $opal.cm('UnboundMethod') : $a).$new(self, meth, name);
    
    };

    def.$instance_methods = function(include_super) {
      var self = this;

      if (include_super == null) {
        include_super = false
      }
      
      var methods = [], proto = self._proto;

      for (var prop in self._proto) {
        if (!include_super && !proto.hasOwnProperty(prop)) {
          continue;
        }

        if (!include_super && proto[prop]._donated) {
          continue;
        }

        if (prop.charAt(0) === '$') {
          methods.push(prop.substr(1));
        }
      }

      return methods;
    
    };

    def.$included = function(mod) {
      var self = this;

      return nil;
    };

    def.$extended = function(mod) {
      var self = this;

      return nil;
    };

    def.$module_eval = TMP_3 = function() {
      var $a, self = this, $iter = TMP_3._p, block = $iter || nil;

      TMP_3._p = null;
      if (block !== false && block !== nil) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "no block given")
      };
      
      var old = block._s,
          result;

      block._s = null;
      result = block.call(self);
      block._s = old;

      return result;
    
    };

    $opal.defn(self, '$class_eval', def.$module_eval);

    def.$module_exec = TMP_4 = function() {
      var self = this, $iter = TMP_4._p, block = $iter || nil;

      TMP_4._p = null;
      
      if (block === nil) {
        throw new Error("no block given");
      }

      var block_self = block._s, result;

      block._s = null;
      result = block.apply(self, $slice.call(arguments));
      block._s = block_self;

      return result;
    
    };

    $opal.defn(self, '$class_exec', def.$module_exec);

    def['$method_defined?'] = function(method) {
      var self = this;

      
      var body = self._proto['$' + method];
      return (!!body) && !body.rb_stub;
    
    };

    def.$module_function = function(methods) {
      var self = this;

      methods = $slice.call(arguments, 0);
      
      for (var i = 0, length = methods.length; i < length; i++) {
        var meth = methods[i], func = self._proto['$' + meth];

        self.constructor.prototype['$' + meth] = func;
      }

      return self;
    
    };

    def.$name = function() {
      var self = this;

      
      if (self._full_name) {
        return self._full_name;
      }

      var result = [], base = self;

      while (base) {
        if (base._name === nil) {
          return result.length === 0 ? nil : result.join('::');
        }

        result.unshift(base._name);

        base = base._base_module;

        if (base === $opal.Object) {
          break;
        }
      }

      if (result.length === 0) {
        return nil;
      }

      return self._full_name = result.join('::');
    
    };

    def.$public = function() {
      var self = this;

      return nil;
    };

    def.$private_class_method = function(name) {
      var self = this;

      return self['$' + name] || nil;
    };

    $opal.defn(self, '$private', def.$public);

    $opal.defn(self, '$protected', def.$public);

    def['$private_method_defined?'] = function(obj) {
      var self = this;

      return false;
    };

    def.$private_constant = function() {
      var self = this;

      return nil;
    };

    $opal.defn(self, '$protected_method_defined?', def['$private_method_defined?']);

    $opal.defn(self, '$public_instance_methods', def.$instance_methods);

    $opal.defn(self, '$public_method_defined?', def['$method_defined?']);

    def.$remove_class_variable = function() {
      var self = this;

      return nil;
    };

    def.$remove_const = function(name) {
      var self = this;

      
      var old = self._scope[name];
      delete self._scope[name];
      return old;
    
    };

    def.$to_s = function() {
      var self = this;

      return self.$name().$to_s();
    };

    return (def.$undef_method = function(symbol) {
      var self = this;

      $opal.add_stub_for(self._proto, "$" + symbol);
      return self;
    }, nil) && 'undef_method';
  })(self, null)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$raise', '$allocate']);
  ;
  return (function($base, $super) {
    function $Class(){};
    var self = $Class = $klass($base, $super, 'Class', $Class);

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2;

    $opal.defs(self, '$new', TMP_1 = function(sup) {
      var $a, self = this, $iter = TMP_1._p, block = $iter || nil;

      if (sup == null) {
        sup = (($a = $scope.Object) == null ? $opal.cm('Object') : $a)
      }
      TMP_1._p = null;
      
      if (!sup._isClass || sup.__mod__) {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "superclass must be a Class");
      }

      function AnonClass(){};
      var klass       = Opal.boot(sup, AnonClass)
      klass._name     = nil;
      klass.__parent  = sup;

      // inherit scope from parent
      $opal.create_scope(sup._scope, klass);

      sup.$inherited(klass);

      if (block !== nil) {
        var block_self = block._s;
        block._s = null;
        block.call(klass);
        block._s = block_self;
      }

      return klass;
    ;
    });

    def.$allocate = function() {
      var self = this;

      
      var obj = new self._alloc;
      obj._id = Opal.uid();
      return obj;
    
    };

    def.$inherited = function(cls) {
      var self = this;

      return nil;
    };

    def.$new = TMP_2 = function(args) {
      var self = this, $iter = TMP_2._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_2._p = null;
      
      var obj = self.$allocate();

      obj.$initialize._p = block;
      obj.$initialize.apply(obj, args);
      return obj;
    ;
    };

    return (def.$superclass = function() {
      var self = this;

      return self._super || nil;
    }, nil) && 'superclass';
  })(self, null);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$raise']);
  return (function($base, $super) {
    function $BasicObject(){};
    var self = $BasicObject = $klass($base, $super, 'BasicObject', $BasicObject);

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3, TMP_4;

    $opal.defn(self, '$initialize', function() {
      var self = this;

      return nil;
    });

    $opal.defn(self, '$==', function(other) {
      var self = this;

      return self === other;
    });

    $opal.defn(self, '$__id__', function() {
      var self = this;

      return self._id || (self._id = Opal.uid());
    });

    $opal.defn(self, '$__send__', TMP_1 = function(symbol, args) {
      var self = this, $iter = TMP_1._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_1._p = null;
      
      var func = self['$' + symbol]

      if (func) {
        if (block !== nil) {
          func._p = block;
        }

        return func.apply(self, args);
      }

      if (block !== nil) {
        self.$method_missing._p = block;
      }

      return self.$method_missing.apply(self, [symbol].concat(args));
    
    });

    $opal.defn(self, '$!', function() {
      var self = this;

      return false;
    });

    $opal.defn(self, '$eql?', def['$==']);

    $opal.defn(self, '$equal?', def['$==']);

    $opal.defn(self, '$instance_eval', TMP_2 = function() {
      var $a, self = this, $iter = TMP_2._p, block = $iter || nil;

      TMP_2._p = null;
      if (block !== false && block !== nil) {
        } else {
        (($a = $scope.Kernel) == null ? $opal.cm('Kernel') : $a).$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "no block given")
      };
      
      var old = block._s,
          result;

      block._s = null;
      result = block.call(self, self);
      block._s = old;

      return result;
    
    });

    $opal.defn(self, '$instance_exec', TMP_3 = function(args) {
      var $a, self = this, $iter = TMP_3._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_3._p = null;
      if (block !== false && block !== nil) {
        } else {
        (($a = $scope.Kernel) == null ? $opal.cm('Kernel') : $a).$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "no block given")
      };
      
      var block_self = block._s,
          result;

      block._s = null;
      result = block.apply(self, args);
      block._s = block_self;

      return result;
    
    });

    return ($opal.defn(self, '$method_missing', TMP_4 = function(symbol, args) {
      var $a, self = this, $iter = TMP_4._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_4._p = null;
      return (($a = $scope.Kernel) == null ? $opal.cm('Kernel') : $a).$raise((($a = $scope.NoMethodError) == null ? $opal.cm('NoMethodError') : $a), "undefined method `" + (symbol) + "' for BasicObject instance");
    }), nil) && 'method_missing';
  })(self, null)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $gvars = $opal.gvars;

  $opal.add_stubs(['$raise', '$inspect', '$==', '$name', '$class', '$new', '$respond_to?', '$to_ary', '$to_a', '$allocate', '$copy_instance_variables', '$initialize_clone', '$initialize_copy', '$singleton_class', '$initialize_dup', '$for', '$to_proc', '$append_features', '$extended', '$to_i', '$to_s', '$to_f', '$*', '$===', '$empty?', '$ArgumentError', '$nan?', '$infinite?', '$to_int', '$>', '$length', '$print', '$format', '$puts', '$each', '$<=', '$[]', '$nil?', '$is_a?', '$rand', '$coerce_to', '$respond_to_missing?']);
  return (function($base) {
    var self = $module($base, 'Kernel');

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_9;

    def.$method_missing = TMP_1 = function(symbol, args) {
      var $a, self = this, $iter = TMP_1._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_1._p = null;
      return self.$raise((($a = $scope.NoMethodError) == null ? $opal.cm('NoMethodError') : $a), "undefined method `" + (symbol) + "' for " + (self.$inspect()));
    };

    def['$=~'] = function(obj) {
      var self = this;

      return false;
    };

    def['$==='] = function(other) {
      var self = this;

      return self['$=='](other);
    };

    def['$<=>'] = function(other) {
      var self = this;

      
      if (self['$=='](other)) {
        return 0;
      }

      return nil;
    ;
    };

    def.$method = function(name) {
      var $a, self = this;

      
      var meth = self['$' + name];

      if (!meth || meth.rb_stub) {
        self.$raise((($a = $scope.NameError) == null ? $opal.cm('NameError') : $a), "undefined method `" + (name) + "' for class `" + (self.$class().$name()) + "'");
      }

      return (($a = $scope.Method) == null ? $opal.cm('Method') : $a).$new(self, meth, name);
    
    };

    def.$methods = function(all) {
      var self = this;

      if (all == null) {
        all = true
      }
      
      var methods = [];

      for (var key in self) {
        if (key[0] == "$" && typeof(self[key]) === "function") {
          if (all == false || all === nil) {
            if (!$opal.hasOwnProperty.call(self, key)) {
              continue;
            }
          }
          if (self[key].rb_stub === undefined) {
            methods.push(key.substr(1));
          }
        }
      }

      return methods;
    
    };

    def.$Array = TMP_2 = function(object, args) {
      var self = this, $iter = TMP_2._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_2._p = null;
      
      if (object == null || object === nil) {
        return [];
      }
      else if (object['$respond_to?']("to_ary")) {
        return object.$to_ary();
      }
      else if (object['$respond_to?']("to_a")) {
        return object.$to_a();
      }
      else {
        return [object];
      }
    ;
    };

    def.$caller = function() {
      var self = this;

      return [];
    };

    def.$class = function() {
      var self = this;

      return self._klass;
    };

    def.$copy_instance_variables = function(other) {
      var self = this;

      
      for (var name in other) {
        if (name.charAt(0) !== '$') {
          if (name !== '_id' && name !== '_klass') {
            self[name] = other[name];
          }
        }
      }
    
    };

    def.$clone = function() {
      var self = this, copy = nil;

      copy = self.$class().$allocate();
      copy.$copy_instance_variables(self);
      copy.$initialize_clone(self);
      return copy;
    };

    def.$initialize_clone = function(other) {
      var self = this;

      return self.$initialize_copy(other);
    };

    def.$define_singleton_method = TMP_3 = function(name) {
      var $a, self = this, $iter = TMP_3._p, body = $iter || nil;

      TMP_3._p = null;
      if (body !== false && body !== nil) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to create Proc object without a block")
      };
      
      var jsid   = '$' + name;
      body._jsid = name;
      body._s    = null;
      body._def  = body;

      self.$singleton_class()._proto[jsid] = body;

      return self;
    
    };

    def.$dup = function() {
      var self = this, copy = nil;

      copy = self.$class().$allocate();
      copy.$copy_instance_variables(self);
      copy.$initialize_dup(self);
      return copy;
    };

    def.$initialize_dup = function(other) {
      var self = this;

      return self.$initialize_copy(other);
    };

    def.$enum_for = TMP_4 = function(method, args) {
      var $a, $b, $c, self = this, $iter = TMP_4._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      if (method == null) {
        method = "each"
      }
      TMP_4._p = null;
      return ($a = ($b = (($c = $scope.Enumerator) == null ? $opal.cm('Enumerator') : $c)).$for, $a._p = block.$to_proc(), $a).apply($b, [self, method].concat(args));
    };

    $opal.defn(self, '$to_enum', def.$enum_for);

    def['$equal?'] = function(other) {
      var self = this;

      return self === other;
    };

    def.$extend = function(mods) {
      var self = this;

      mods = $slice.call(arguments, 0);
      
      var singleton = self.$singleton_class();

      for (var i = mods.length - 1; i >= 0; i--) {
        var mod = mods[i];

        (mod).$append_features(singleton);
        (mod).$extended(self);
      }
    ;
      return self;
    };

    def.$format = function(format, args) {
      var self = this;

      args = $slice.call(arguments, 1);
      
      var idx = 0;
      return format.replace(/%(\d+\$)?([-+ 0]*)(\d*|\*(\d+\$)?)(?:\.(\d*|\*(\d+\$)?))?([cspdiubBoxXfgeEG])|(%%)/g, function(str, idx_str, flags, width_str, w_idx_str, prec_str, p_idx_str, spec, escaped) {
        if (escaped) {
          return '%';
        }

        var width,
        prec,
        is_integer_spec = ("diubBoxX".indexOf(spec) != -1),
        is_float_spec = ("eEfgG".indexOf(spec) != -1),
        prefix = '',
        obj;

        if (width_str === undefined) {
          width = undefined;
        } else if (width_str.charAt(0) == '*') {
          var w_idx = idx++;
          if (w_idx_str) {
            w_idx = parseInt(w_idx_str, 10) - 1;
          }
          width = (args[w_idx]).$to_i();
        } else {
          width = parseInt(width_str, 10);
        }
        if (!prec_str) {
          prec = is_float_spec ? 6 : undefined;
        } else if (prec_str.charAt(0) == '*') {
          var p_idx = idx++;
          if (p_idx_str) {
            p_idx = parseInt(p_idx_str, 10) - 1;
          }
          prec = (args[p_idx]).$to_i();
        } else {
          prec = parseInt(prec_str, 10);
        }
        if (idx_str) {
          idx = parseInt(idx_str, 10) - 1;
        }
        switch (spec) {
        case 'c':
          obj = args[idx];
          if (obj._isString) {
            str = obj.charAt(0);
          } else {
            str = String.fromCharCode((obj).$to_i());
          }
          break;
        case 's':
          str = (args[idx]).$to_s();
          if (prec !== undefined) {
            str = str.substr(0, prec);
          }
          break;
        case 'p':
          str = (args[idx]).$inspect();
          if (prec !== undefined) {
            str = str.substr(0, prec);
          }
          break;
        case 'd':
        case 'i':
        case 'u':
          str = (args[idx]).$to_i().toString();
          break;
        case 'b':
        case 'B':
          str = (args[idx]).$to_i().toString(2);
          break;
        case 'o':
          str = (args[idx]).$to_i().toString(8);
          break;
        case 'x':
        case 'X':
          str = (args[idx]).$to_i().toString(16);
          break;
        case 'e':
        case 'E':
          str = (args[idx]).$to_f().toExponential(prec);
          break;
        case 'f':
          str = (args[idx]).$to_f().toFixed(prec);
          break;
        case 'g':
        case 'G':
          str = (args[idx]).$to_f().toPrecision(prec);
          break;
        }
        idx++;
        if (is_integer_spec || is_float_spec) {
          if (str.charAt(0) == '-') {
            prefix = '-';
            str = str.substr(1);
          } else {
            if (flags.indexOf('+') != -1) {
              prefix = '+';
            } else if (flags.indexOf(' ') != -1) {
              prefix = ' ';
            }
          }
        }
        if (is_integer_spec && prec !== undefined) {
          if (str.length < prec) {
            str = "0"['$*'](prec - str.length) + str;
          }
        }
        var total_len = prefix.length + str.length;
        if (width !== undefined && total_len < width) {
          if (flags.indexOf('-') != -1) {
            str = str + " "['$*'](width - total_len);
          } else {
            var pad_char = ' ';
            if (flags.indexOf('0') != -1) {
              str = "0"['$*'](width - total_len) + str;
            } else {
              prefix = " "['$*'](width - total_len) + prefix;
            }
          }
        }
        var result = prefix + str;
        if ('XEG'.indexOf(spec) != -1) {
          result = result.toUpperCase();
        }
        return result;
      });
    
    };

    def.$hash = function() {
      var self = this;

      return self._id;
    };

    def.$initialize_copy = function(other) {
      var self = this;

      return nil;
    };

    def.$inspect = function() {
      var self = this;

      return self.$to_s();
    };

    def['$instance_of?'] = function(klass) {
      var self = this;

      return self._klass === klass;
    };

    def['$instance_variable_defined?'] = function(name) {
      var self = this;

      return $opal.hasOwnProperty.call(self, name.substr(1));
    };

    def.$instance_variable_get = function(name) {
      var self = this;

      
      var ivar = self[name.substr(1)];

      return ivar == null ? nil : ivar;
    
    };

    def.$instance_variable_set = function(name, value) {
      var self = this;

      return self[name.substr(1)] = value;
    };

    def.$instance_variables = function() {
      var self = this;

      
      var result = [];

      for (var name in self) {
        if (name.charAt(0) !== '$') {
          if (name !== '_klass' && name !== '_id') {
            result.push('@' + name);
          }
        }
      }

      return result;
    
    };

    def.$Integer = function(value, base) {
      var $a, $b, self = this, $case = nil;

      if (base == null) {
        base = nil
      }
      if ((($a = (($b = $scope.String) == null ? $opal.cm('String') : $b)['$==='](value)) !== nil && (!$a._isBoolean || $a == true))) {
        if ((($a = value['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "invalid value for Integer: (empty string)")};
        return parseInt(value, ((($a = base) !== false && $a !== nil) ? $a : undefined));};
      if (base !== false && base !== nil) {
        self.$raise(self.$ArgumentError("base is only valid for String values"))};
      return (function() {$case = value;if ((($a = $scope.Integer) == null ? $opal.cm('Integer') : $a)['$===']($case)) {return value}else if ((($a = $scope.Float) == null ? $opal.cm('Float') : $a)['$===']($case)) {if ((($a = ((($b = value['$nan?']()) !== false && $b !== nil) ? $b : value['$infinite?']())) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.FloatDomainError) == null ? $opal.cm('FloatDomainError') : $a), "unable to coerce " + (value) + " to Integer")};
      return value.$to_int();}else if ((($a = $scope.NilClass) == null ? $opal.cm('NilClass') : $a)['$===']($case)) {return self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "can't convert nil into Integer")}else {if ((($a = value['$respond_to?']("to_int")) !== nil && (!$a._isBoolean || $a == true))) {
        return value.$to_int()
      } else if ((($a = value['$respond_to?']("to_i")) !== nil && (!$a._isBoolean || $a == true))) {
        return value.$to_i()
        } else {
        return self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "can't convert " + (value.$class()) + " into Integer")
      }}})();
    };

    def.$Float = function(value) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.String) == null ? $opal.cm('String') : $b)['$==='](value)) !== nil && (!$a._isBoolean || $a == true))) {
        return parseFloat(value);
      } else if ((($a = value['$respond_to?']("to_f")) !== nil && (!$a._isBoolean || $a == true))) {
        return value.$to_f()
        } else {
        return self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "can't convert " + (value.$class()) + " into Float")
      };
    };

    def['$is_a?'] = function(klass) {
      var self = this;

      return $opal.is_a(self, klass);
    };

    $opal.defn(self, '$kind_of?', def['$is_a?']);

    def.$lambda = TMP_5 = function() {
      var self = this, $iter = TMP_5._p, block = $iter || nil;

      TMP_5._p = null;
      block.is_lambda = true;
      return block;
    };

    def.$loop = TMP_6 = function() {
      var self = this, $iter = TMP_6._p, block = $iter || nil;

      TMP_6._p = null;
      
      while (true) {
        if (block() === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def['$nil?'] = function() {
      var self = this;

      return false;
    };

    $opal.defn(self, '$object_id', def.$__id__);

    def.$printf = function(args) {
      var $a, self = this;

      args = $slice.call(arguments, 0);
      if (args.$length()['$>'](0)) {
        self.$print(($a = self).$format.apply($a, [].concat(args)))};
      return nil;
    };

    def.$private_methods = function() {
      var self = this;

      return [];
    };

    def.$proc = TMP_7 = function() {
      var $a, self = this, $iter = TMP_7._p, block = $iter || nil;

      TMP_7._p = null;
      if (block !== false && block !== nil) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to create Proc object without a block")
      };
      block.is_lambda = false;
      return block;
    };

    def.$puts = function(strs) {
      var $a, self = this;
      if ($gvars.stdout == null) $gvars.stdout = nil;

      strs = $slice.call(arguments, 0);
      return ($a = $gvars.stdout).$puts.apply($a, [].concat(strs));
    };

    def.$p = function(args) {
      var $a, $b, TMP_8, self = this;

      args = $slice.call(arguments, 0);
      ($a = ($b = args).$each, $a._p = (TMP_8 = function(obj){var self = TMP_8._s || this;
        if ($gvars.stdout == null) $gvars.stdout = nil;
if (obj == null) obj = nil;
      return $gvars.stdout.$puts(obj.$inspect())}, TMP_8._s = self, TMP_8), $a).call($b);
      if (args.$length()['$<='](1)) {
        return args['$[]'](0)
        } else {
        return args
      };
    };

    def.$print = function(strs) {
      var $a, self = this;
      if ($gvars.stdout == null) $gvars.stdout = nil;

      strs = $slice.call(arguments, 0);
      return ($a = $gvars.stdout).$print.apply($a, [].concat(strs));
    };

    def.$warn = function(strs) {
      var $a, $b, self = this;
      if ($gvars.VERBOSE == null) $gvars.VERBOSE = nil;
      if ($gvars.stderr == null) $gvars.stderr = nil;

      strs = $slice.call(arguments, 0);
      if ((($a = ((($b = $gvars.VERBOSE['$nil?']()) !== false && $b !== nil) ? $b : strs['$empty?']())) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        ($a = $gvars.stderr).$puts.apply($a, [].concat(strs))
      };
      return nil;
    };

    def.$raise = function(exception, string) {
      var $a, self = this;
      if ($gvars["!"] == null) $gvars["!"] = nil;

      
      if (exception == null && $gvars["!"]) {
        exception = $gvars["!"];
      }
      else if (exception._isString) {
        exception = (($a = $scope.RuntimeError) == null ? $opal.cm('RuntimeError') : $a).$new(exception);
      }
      else if (!exception['$is_a?']((($a = $scope.Exception) == null ? $opal.cm('Exception') : $a))) {
        exception = exception.$new(string);
      }

      $gvars["!"] = exception;
      throw exception;
    ;
    };

    $opal.defn(self, '$fail', def.$raise);

    def.$rand = function(max) {
      var $a, self = this;

      
      if (max === undefined) {
        return Math.random();
      }
      else if (max._isRange) {
        var arr = max.$to_a();

        return arr[self.$rand(arr.length)];
      }
      else {
        return Math.floor(Math.random() *
          Math.abs((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(max, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")));
      }
    
    };

    $opal.defn(self, '$srand', def.$rand);

    def['$respond_to?'] = function(name, include_all) {
      var $a, self = this;

      if (include_all == null) {
        include_all = false
      }
      if ((($a = self['$respond_to_missing?'](name)) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      
      var body = self['$' + name];

      if (typeof(body) === "function" && !body.rb_stub) {
        return true;
      }
    
      return false;
    };

    $opal.defn(self, '$send', def.$__send__);

    $opal.defn(self, '$public_send', def.$__send__);

    def.$singleton_class = function() {
      var self = this;

      
      if (self._isClass) {
        if (self.__meta__) {
          return self.__meta__;
        }

        var meta = new $opal.Class._alloc;
        meta._klass = $opal.Class;
        self.__meta__ = meta;
        // FIXME - is this right? (probably - methods defined on
        // class' singleton should also go to subclasses?)
        meta._proto = self.constructor.prototype;
        meta._isSingleton = true;
        meta.__inc__ = [];
        meta._methods = [];

        meta._scope = self._scope;

        return meta;
      }

      if (self._isClass) {
        return self._klass;
      }

      if (self.__meta__) {
        return self.__meta__;
      }

      else {
        var orig_class = self._klass,
            class_id   = "#<Class:#<" + orig_class._name + ":" + orig_class._id + ">>";

        var Singleton = function () {};
        var meta = Opal.boot(orig_class, Singleton);
        meta._name = class_id;

        meta._proto = self;
        self.__meta__ = meta;
        meta._klass = orig_class._klass;
        meta._scope = orig_class._scope;
        meta.__parent = orig_class;

        return meta;
      }
    
    };

    $opal.defn(self, '$sprintf', def.$format);

    def.$String = function(str) {
      var self = this;

      return String(str);
    };

    def.$tap = TMP_9 = function() {
      var self = this, $iter = TMP_9._p, block = $iter || nil;

      TMP_9._p = null;
      if ($opal.$yield1(block, self) === $breaker) return $breaker.$v;
      return self;
    };

    def.$to_proc = function() {
      var self = this;

      return self;
    };

    def.$to_s = function() {
      var self = this;

      return "#<" + self.$class().$name() + ":" + self._id + ">";
    };

    def.$freeze = function() {
      var self = this;

      self.___frozen___ = true;
      return self;
    };

    def['$frozen?'] = function() {
      var $a, self = this;
      if (self.___frozen___ == null) self.___frozen___ = nil;

      return ((($a = self.___frozen___) !== false && $a !== nil) ? $a : false);
    };

    def['$respond_to_missing?'] = function(method_name) {
      var self = this;

      return false;
    };
        ;$opal.donate(self, ["$method_missing", "$=~", "$===", "$<=>", "$method", "$methods", "$Array", "$caller", "$class", "$copy_instance_variables", "$clone", "$initialize_clone", "$define_singleton_method", "$dup", "$initialize_dup", "$enum_for", "$to_enum", "$equal?", "$extend", "$format", "$hash", "$initialize_copy", "$inspect", "$instance_of?", "$instance_variable_defined?", "$instance_variable_get", "$instance_variable_set", "$instance_variables", "$Integer", "$Float", "$is_a?", "$kind_of?", "$lambda", "$loop", "$nil?", "$object_id", "$printf", "$private_methods", "$proc", "$puts", "$p", "$print", "$warn", "$raise", "$fail", "$rand", "$srand", "$respond_to?", "$send", "$public_send", "$singleton_class", "$sprintf", "$String", "$tap", "$to_proc", "$to_s", "$freeze", "$frozen?", "$respond_to_missing?"]);
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$raise']);
  (function($base, $super) {
    function $NilClass(){};
    var self = $NilClass = $klass($base, $super, 'NilClass', $NilClass);

    var def = self._proto, $scope = self._scope;

    def['$!'] = function() {
      var self = this;

      return true;
    };

    def['$&'] = function(other) {
      var self = this;

      return false;
    };

    def['$|'] = function(other) {
      var self = this;

      return other !== false && other !== nil;
    };

    def['$^'] = function(other) {
      var self = this;

      return other !== false && other !== nil;
    };

    def['$=='] = function(other) {
      var self = this;

      return other === nil;
    };

    def.$dup = function() {
      var $a, self = this;

      return self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a));
    };

    def.$inspect = function() {
      var self = this;

      return "nil";
    };

    def['$nil?'] = function() {
      var self = this;

      return true;
    };

    def.$singleton_class = function() {
      var $a, self = this;

      return (($a = $scope.NilClass) == null ? $opal.cm('NilClass') : $a);
    };

    def.$to_a = function() {
      var self = this;

      return [];
    };

    def.$to_h = function() {
      var self = this;

      return $opal.hash();
    };

    def.$to_i = function() {
      var self = this;

      return 0;
    };

    $opal.defn(self, '$to_f', def.$to_i);

    def.$to_s = function() {
      var self = this;

      return "";
    };

    def.$object_id = function() {
      var $a, self = this;

      return (($a = $scope.NilClass) == null ? $opal.cm('NilClass') : $a)._id || ((($a = $scope.NilClass) == null ? $opal.cm('NilClass') : $a)._id = $opal.uid());
    };

    return $opal.defn(self, '$hash', def.$object_id);
  })(self, null);
  return $opal.cdecl($scope, 'NIL', nil);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$undef_method']);
  (function($base, $super) {
    function $Boolean(){};
    var self = $Boolean = $klass($base, $super, 'Boolean', $Boolean);

    var def = self._proto, $scope = self._scope;

    def._isBoolean = true;

    (function(self) {
      var $scope = self._scope, def = self._proto;

      return self.$undef_method("new")
    })(self.$singleton_class());

    def['$!'] = function() {
      var self = this;

      return self != true;
    };

    def['$&'] = function(other) {
      var self = this;

      return (self == true) ? (other !== false && other !== nil) : false;
    };

    def['$|'] = function(other) {
      var self = this;

      return (self == true) ? true : (other !== false && other !== nil);
    };

    def['$^'] = function(other) {
      var self = this;

      return (self == true) ? (other === false || other === nil) : (other !== false && other !== nil);
    };

    def['$=='] = function(other) {
      var self = this;

      return (self == true) === other.valueOf();
    };

    $opal.defn(self, '$equal?', def['$==']);

    $opal.defn(self, '$singleton_class', def.$class);

    return (def.$to_s = function() {
      var self = this;

      return (self == true) ? 'true' : 'false';
    }, nil) && 'to_s';
  })(self, null);
  $opal.cdecl($scope, 'TrueClass', (($a = $scope.Boolean) == null ? $opal.cm('Boolean') : $a));
  $opal.cdecl($scope, 'FalseClass', (($a = $scope.Boolean) == null ? $opal.cm('Boolean') : $a));
  $opal.cdecl($scope, 'TRUE', true);
  return $opal.cdecl($scope, 'FALSE', false);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $module = $opal.module;

  $opal.add_stubs(['$attr_reader', '$name', '$class']);
  (function($base, $super) {
    function $Exception(){};
    var self = $Exception = $klass($base, $super, 'Exception', $Exception);

    var def = self._proto, $scope = self._scope;

    def.message = nil;
    self.$attr_reader("message");

    $opal.defs(self, '$new', function(message) {
      var self = this;

      if (message == null) {
        message = ""
      }
      
      var err = new Error(message);
      err._klass = self;
      err.name = self._name;
      return err;
    
    });

    def.$backtrace = function() {
      var self = this;

      
      var backtrace = self.stack;

      if (typeof(backtrace) === 'string') {
        return backtrace.split("\n").slice(0, 15);
      }
      else if (backtrace) {
        return backtrace.slice(0, 15);
      }

      return [];
    
    };

    def.$inspect = function() {
      var self = this;

      return "#<" + (self.$class().$name()) + ": '" + (self.message) + "'>";
    };

    return $opal.defn(self, '$to_s', def.$message);
  })(self, null);
  (function($base, $super) {
    function $ScriptError(){};
    var self = $ScriptError = $klass($base, $super, 'ScriptError', $ScriptError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.Exception) == null ? $opal.cm('Exception') : $a));
  (function($base, $super) {
    function $SyntaxError(){};
    var self = $SyntaxError = $klass($base, $super, 'SyntaxError', $SyntaxError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.ScriptError) == null ? $opal.cm('ScriptError') : $a));
  (function($base, $super) {
    function $LoadError(){};
    var self = $LoadError = $klass($base, $super, 'LoadError', $LoadError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.ScriptError) == null ? $opal.cm('ScriptError') : $a));
  (function($base, $super) {
    function $NotImplementedError(){};
    var self = $NotImplementedError = $klass($base, $super, 'NotImplementedError', $NotImplementedError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.ScriptError) == null ? $opal.cm('ScriptError') : $a));
  (function($base, $super) {
    function $SystemExit(){};
    var self = $SystemExit = $klass($base, $super, 'SystemExit', $SystemExit);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.Exception) == null ? $opal.cm('Exception') : $a));
  (function($base, $super) {
    function $StandardError(){};
    var self = $StandardError = $klass($base, $super, 'StandardError', $StandardError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.Exception) == null ? $opal.cm('Exception') : $a));
  (function($base, $super) {
    function $NameError(){};
    var self = $NameError = $klass($base, $super, 'NameError', $NameError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  (function($base, $super) {
    function $NoMethodError(){};
    var self = $NoMethodError = $klass($base, $super, 'NoMethodError', $NoMethodError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.NameError) == null ? $opal.cm('NameError') : $a));
  (function($base, $super) {
    function $RuntimeError(){};
    var self = $RuntimeError = $klass($base, $super, 'RuntimeError', $RuntimeError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  (function($base, $super) {
    function $LocalJumpError(){};
    var self = $LocalJumpError = $klass($base, $super, 'LocalJumpError', $LocalJumpError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  (function($base, $super) {
    function $TypeError(){};
    var self = $TypeError = $klass($base, $super, 'TypeError', $TypeError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  (function($base, $super) {
    function $ArgumentError(){};
    var self = $ArgumentError = $klass($base, $super, 'ArgumentError', $ArgumentError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  (function($base, $super) {
    function $IndexError(){};
    var self = $IndexError = $klass($base, $super, 'IndexError', $IndexError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  (function($base, $super) {
    function $StopIteration(){};
    var self = $StopIteration = $klass($base, $super, 'StopIteration', $StopIteration);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a));
  (function($base, $super) {
    function $KeyError(){};
    var self = $KeyError = $klass($base, $super, 'KeyError', $KeyError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a));
  (function($base, $super) {
    function $RangeError(){};
    var self = $RangeError = $klass($base, $super, 'RangeError', $RangeError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  (function($base, $super) {
    function $FloatDomainError(){};
    var self = $FloatDomainError = $klass($base, $super, 'FloatDomainError', $FloatDomainError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.RangeError) == null ? $opal.cm('RangeError') : $a));
  (function($base, $super) {
    function $IOError(){};
    var self = $IOError = $klass($base, $super, 'IOError', $IOError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  (function($base, $super) {
    function $SystemCallError(){};
    var self = $SystemCallError = $klass($base, $super, 'SystemCallError', $SystemCallError);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a));
  return (function($base) {
    var self = $module($base, 'Errno');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $EINVAL(){};
      var self = $EINVAL = $klass($base, $super, 'EINVAL', $EINVAL);

      var def = self._proto, $scope = self._scope, TMP_1;

      return ($opal.defs(self, '$new', TMP_1 = function() {
        var self = this, $iter = TMP_1._p, $yield = $iter || nil;

        TMP_1._p = null;
        return $opal.find_super_dispatcher(self, 'new', TMP_1, null, $EINVAL).apply(self, ["Invalid argument"]);
      }), nil) && 'new'
    })(self, (($a = $scope.SystemCallError) == null ? $opal.cm('SystemCallError') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$respond_to?', '$to_str', '$to_s', '$coerce_to', '$new', '$raise', '$class', '$call']);
  return (function($base, $super) {
    function $Regexp(){};
    var self = $Regexp = $klass($base, $super, 'Regexp', $Regexp);

    var def = self._proto, $scope = self._scope, TMP_1;

    def._isRegexp = true;

    (function(self) {
      var $scope = self._scope, def = self._proto;

      self._proto.$escape = function(string) {
        var self = this;

        
        return string.replace(/([-[\]\/{}()*+?.^$\\| ])/g, '\\$1')
                     .replace(/[\n]/g, '\\n')
                     .replace(/[\r]/g, '\\r')
                     .replace(/[\f]/g, '\\f')
                     .replace(/[\t]/g, '\\t');
      
      };
      self._proto.$quote = self._proto.$escape;
      self._proto.$union = function(parts) {
        var self = this;

        parts = $slice.call(arguments, 0);
        return new RegExp(parts.join(''));
      };
      return (self._proto.$new = function(regexp, options) {
        var self = this;

        return new RegExp(regexp, options);
      }, nil) && 'new';
    })(self.$singleton_class());

    def['$=='] = function(other) {
      var self = this;

      return other.constructor == RegExp && self.toString() === other.toString();
    };

    def['$==='] = function(str) {
      var self = this;

      
      if (!str._isString && str['$respond_to?']("to_str")) {
        str = str.$to_str();
      }

      if (!str._isString) {
        return false;
      }

      return self.test(str);
    ;
    };

    def['$=~'] = function(string) {
      var $a, self = this;

      if ((($a = string === nil) !== nil && (!$a._isBoolean || $a == true))) {
        $gvars["~"] = $gvars["`"] = $gvars["'"] = nil;
        return nil;};
      string = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(string, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();
      
      var re = self;

      if (re.global) {
        // should we clear it afterwards too?
        re.lastIndex = 0;
      }
      else {
        // rewrite regular expression to add the global flag to capture pre/post match
        re = new RegExp(re.source, 'g' + (re.multiline ? 'm' : '') + (re.ignoreCase ? 'i' : ''));
      }

      var result = re.exec(string);

      if (result) {
        $gvars["~"] = (($a = $scope.MatchData) == null ? $opal.cm('MatchData') : $a).$new(re, result);
      }
      else {
        $gvars["~"] = $gvars["`"] = $gvars["'"] = nil;
      }

      return result ? result.index : nil;
    
    };

    $opal.defn(self, '$eql?', def['$==']);

    def.$inspect = function() {
      var self = this;

      return self.toString();
    };

    def.$match = TMP_1 = function(string, pos) {
      var $a, self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      if ((($a = string === nil) !== nil && (!$a._isBoolean || $a == true))) {
        $gvars["~"] = $gvars["`"] = $gvars["'"] = nil;
        return nil;};
      if ((($a = string._isString == null) !== nil && (!$a._isBoolean || $a == true))) {
        if ((($a = string['$respond_to?']("to_str")) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "no implicit conversion of " + (string.$class()) + " into String")
        };
        string = string.$to_str();};
      
      var re = self;

      if (re.global) {
        // should we clear it afterwards too?
        re.lastIndex = 0;
      }
      else {
        re = new RegExp(re.source, 'g' + (re.multiline ? 'm' : '') + (re.ignoreCase ? 'i' : ''));
      }

      var result = re.exec(string);

      if (result) {
        result = $gvars["~"] = (($a = $scope.MatchData) == null ? $opal.cm('MatchData') : $a).$new(re, result);

        if (block === nil) {
          return result;
        }
        else {
          return block.$call(result);
        }
      }
      else {
        return $gvars["~"] = $gvars["`"] = $gvars["'"] = nil;
      }
    
    };

    def.$source = function() {
      var self = this;

      return self.source;
    };

    return $opal.defn(self, '$to_s', def.$source);
  })(self, null)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module;

  $opal.add_stubs(['$===', '$>', '$<', '$equal?', '$<=>', '$==', '$normalize', '$raise', '$class', '$>=', '$<=']);
  return (function($base) {
    var self = $module($base, 'Comparable');

    var def = self._proto, $scope = self._scope;

    $opal.defs(self, '$normalize', function(what) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Integer) == null ? $opal.cm('Integer') : $b)['$==='](what)) !== nil && (!$a._isBoolean || $a == true))) {
        return what};
      if (what['$>'](0)) {
        return 1};
      if (what['$<'](0)) {
        return -1};
      return 0;
    });

    def['$=='] = function(other) {
      var $a, self = this, cmp = nil;

      try {
      if ((($a = self['$equal?'](other)) !== nil && (!$a._isBoolean || $a == true))) {
          return true};
        if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          return false
        };
        return (($a = $scope.Comparable) == null ? $opal.cm('Comparable') : $a).$normalize(cmp)['$=='](0);
      } catch ($err) {if ($opal.$rescue($err, [(($a = $scope.StandardError) == null ? $opal.cm('StandardError') : $a)])) {
        return false
        }else { throw $err; }
      };
    };

    def['$>'] = function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return (($a = $scope.Comparable) == null ? $opal.cm('Comparable') : $a).$normalize(cmp)['$>'](0);
    };

    def['$>='] = function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return (($a = $scope.Comparable) == null ? $opal.cm('Comparable') : $a).$normalize(cmp)['$>='](0);
    };

    def['$<'] = function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return (($a = $scope.Comparable) == null ? $opal.cm('Comparable') : $a).$normalize(cmp)['$<'](0);
    };

    def['$<='] = function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return (($a = $scope.Comparable) == null ? $opal.cm('Comparable') : $a).$normalize(cmp)['$<='](0);
    };

    def['$between?'] = function(min, max) {
      var self = this;

      if (self['$<'](min)) {
        return false};
      if (self['$>'](max)) {
        return false};
      return true;
    };
        ;$opal.donate(self, ["$==", "$>", "$>=", "$<", "$<=", "$between?"]);
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module;

  $opal.add_stubs(['$raise', '$enum_for', '$flatten', '$map', '$==', '$destructure', '$nil?', '$coerce_to!', '$coerce_to', '$===', '$new', '$<<', '$[]', '$[]=', '$inspect', '$__send__', '$yield', '$enumerator_size', '$respond_to?', '$size', '$private', '$compare', '$<=>', '$dup', '$sort', '$call', '$first', '$zip', '$to_a']);
  return (function($base) {
    var self = $module($base, 'Enumerable');

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18, TMP_19, TMP_20, TMP_22, TMP_23, TMP_24, TMP_25, TMP_26, TMP_27, TMP_28, TMP_29, TMP_30, TMP_31, TMP_32, TMP_33, TMP_35, TMP_36, TMP_40, TMP_41;

    def['$all?'] = TMP_1 = function() {
      var $a, self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      
      var result = true;

      if (block !== nil) {
        self.$each._p = function() {
          var value = $opal.$yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) === nil || ($a._isBoolean && $a == false))) {
            result = false;
            return $breaker;
          }
        }
      }
      else {
        self.$each._p = function(obj) {
          if (arguments.length == 1 && (($a = obj) === nil || ($a._isBoolean && $a == false))) {
            result = false;
            return $breaker;
          }
        }
      }

      self.$each();

      return result;
    
    };

    def['$any?'] = TMP_2 = function() {
      var $a, self = this, $iter = TMP_2._p, block = $iter || nil;

      TMP_2._p = null;
      
      var result = false;

      if (block !== nil) {
        self.$each._p = function() {
          var value = $opal.$yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            result = true;
            return $breaker;
          }
        };
      }
      else {
        self.$each._p = function(obj) {
          if (arguments.length != 1 || (($a = obj) !== nil && (!$a._isBoolean || $a == true))) {
            result = true;
            return $breaker;
          }
        }
      }

      self.$each();

      return result;
    
    };

    def.$chunk = TMP_3 = function(state) {
      var $a, self = this, $iter = TMP_3._p, block = $iter || nil;

      TMP_3._p = null;
      return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
    };

    def.$collect = TMP_4 = function() {
      var self = this, $iter = TMP_4._p, block = $iter || nil;

      TMP_4._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("collect")
      };
      
      var result = [];

      self.$each._p = function() {
        var value = $opal.$yieldX(block, arguments);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        result.push(value);
      };

      self.$each();

      return result;
    
    };

    def.$collect_concat = TMP_5 = function() {
      var $a, $b, TMP_6, self = this, $iter = TMP_5._p, block = $iter || nil;

      TMP_5._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("collect_concat")
      };
      return ($a = ($b = self).$map, $a._p = (TMP_6 = function(item){var self = TMP_6._s || this, $a;
if (item == null) item = nil;
      return $a = $opal.$yield1(block, item), $a === $breaker ? $a : $a}, TMP_6._s = self, TMP_6), $a).call($b).$flatten(1);
    };

    def.$count = TMP_7 = function(object) {
      var $a, self = this, $iter = TMP_7._p, block = $iter || nil;

      TMP_7._p = null;
      
      var result = 0;

      if (object != null) {
        block = function() {
          return (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments)['$=='](object);
        };
      }
      else if (block === nil) {
        block = function() { return true; };
      }

      self.$each._p = function() {
        var value = $opal.$yieldX(block, arguments);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
          result++;
        }
      }

      self.$each();

      return result;
    
    };

    def.$cycle = TMP_8 = function(n) {
      var $a, self = this, $iter = TMP_8._p, block = $iter || nil;

      if (n == null) {
        n = nil
      }
      TMP_8._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("cycle", n)
      };
      if ((($a = n['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        n = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](n, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        if ((($a = n <= 0) !== nil && (!$a._isBoolean || $a == true))) {
          return nil};
      };
      
      var result,
          all  = [];

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = $opal.$yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        all.push(param);
      }

      self.$each();

      if (result !== undefined) {
        return result;
      }

      if (all.length === 0) {
        return nil;
      }
    
      if ((($a = n['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
        
        while (true) {
          for (var i = 0, length = all.length; i < length; i++) {
            var value = $opal.$yield1(block, all[i]);

            if (value === $breaker) {
              return $breaker.$v;
            }
          }
        }
      
        } else {
        
        while (n > 1) {
          for (var i = 0, length = all.length; i < length; i++) {
            var value = $opal.$yield1(block, all[i]);

            if (value === $breaker) {
              return $breaker.$v;
            }
          }

          n--;
        }
      
      };
    };

    def.$detect = TMP_9 = function(ifnone) {
      var $a, self = this, $iter = TMP_9._p, block = $iter || nil;

      TMP_9._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("detect", ifnone)
      };
      
      var result = undefined;

      self.$each._p = function() {
        var params = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value  = $opal.$yield1(block, params);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
          result = params;
          return $breaker;
        }
      };

      self.$each();

      if (result === undefined && ifnone !== undefined) {
        if (typeof(ifnone) === 'function') {
          result = ifnone();
        }
        else {
          result = ifnone;
        }
      }

      return result === undefined ? nil : result;
    
    };

    def.$drop = function(number) {
      var $a, self = this;

      number = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(number, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      if ((($a = number < 0) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "attempt to drop negative size")};
      
      var result  = [],
          current = 0;

      self.$each._p = function() {
        if (number <= current) {
          result.push((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments));
        }

        current++;
      };

      self.$each()

      return result;
    
    };

    def.$drop_while = TMP_10 = function() {
      var $a, self = this, $iter = TMP_10._p, block = $iter || nil;

      TMP_10._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("drop_while")
      };
      
      var result   = [],
          dropping = true;

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

        if (dropping) {
          var value = $opal.$yield1(block, param);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) === nil || ($a._isBoolean && $a == false))) {
            dropping = false;
            result.push(param);
          }
        }
        else {
          result.push(param);
        }
      };

      self.$each();

      return result;
    
    };

    def.$each_cons = TMP_11 = function(n) {
      var $a, self = this, $iter = TMP_11._p, block = $iter || nil;

      TMP_11._p = null;
      return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
    };

    def.$each_entry = TMP_12 = function() {
      var $a, self = this, $iter = TMP_12._p, block = $iter || nil;

      TMP_12._p = null;
      return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
    };

    def.$each_slice = TMP_13 = function(n) {
      var $a, self = this, $iter = TMP_13._p, block = $iter || nil;

      TMP_13._p = null;
      n = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(n, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      if ((($a = n <= 0) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "invalid slice size")};
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_slice", n)
      };
      
      var result,
          slice = []

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

        slice.push(param);

        if (slice.length === n) {
          if ($opal.$yield1(block, slice) === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          slice = [];
        }
      };

      self.$each();

      if (result !== undefined) {
        return result;
      }

      // our "last" group, if smaller than n then won't have been yielded
      if (slice.length > 0) {
        if ($opal.$yield1(block, slice) === $breaker) {
          return $breaker.$v;
        }
      }
    ;
      return nil;
    };

    def.$each_with_index = TMP_14 = function(args) {
      var $a, $b, self = this, $iter = TMP_14._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_14._p = null;
      if ((block !== nil)) {
        } else {
        return ($a = self).$enum_for.apply($a, ["each_with_index"].concat(args))
      };
      
      var result,
          index = 0;

      self.$each._p = function() {
        var param = (($b = $scope.Opal) == null ? $opal.cm('Opal') : $b).$destructure(arguments),
            value = block(param, index);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        index++;
      };

      self.$each.apply(self, args);

      if (result !== undefined) {
        return result;
      }
    
      return self;
    };

    def.$each_with_object = TMP_15 = function(object) {
      var $a, self = this, $iter = TMP_15._p, block = $iter || nil;

      TMP_15._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_with_object", object)
      };
      
      var result;

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = block(param, object);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }
      };

      self.$each();

      if (result !== undefined) {
        return result;
      }
    
      return object;
    };

    def.$entries = function(args) {
      var $a, self = this;

      args = $slice.call(arguments, 0);
      
      var result = [];

      self.$each._p = function() {
        result.push((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments));
      };

      self.$each.apply(self, args);

      return result;
    
    };

    $opal.defn(self, '$find', def.$detect);

    def.$find_all = TMP_16 = function() {
      var $a, self = this, $iter = TMP_16._p, block = $iter || nil;

      TMP_16._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("find_all")
      };
      
      var result = [];

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = $opal.$yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
          result.push(param);
        }
      };

      self.$each();

      return result;
    
    };

    def.$find_index = TMP_17 = function(object) {
      var $a, self = this, $iter = TMP_17._p, block = $iter || nil;

      TMP_17._p = null;
      if ((($a = object === undefined && block === nil) !== nil && (!$a._isBoolean || $a == true))) {
        return self.$enum_for("find_index")};
      
      var result = nil,
          index  = 0;

      if (object != null) {
        self.$each._p = function() {
          var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if ((param)['$=='](object)) {
            result = index;
            return $breaker;
          }

          index += 1;
        };
      }
      else if (block !== nil) {
        self.$each._p = function() {
          var value = $opal.$yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            result = index;
            return $breaker;
          }

          index += 1;
        };
      }

      self.$each();

      return result;
    
    };

    def.$first = function(number) {
      var $a, self = this, result = nil;

      if ((($a = number === undefined) !== nil && (!$a._isBoolean || $a == true))) {
        result = nil;
        
        self.$each._p = function() {
          result = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          return $breaker;
        };

        self.$each();
      ;
        } else {
        result = [];
        number = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(number, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        if ((($a = number < 0) !== nil && (!$a._isBoolean || $a == true))) {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "attempt to take negative size")};
        if ((($a = number == 0) !== nil && (!$a._isBoolean || $a == true))) {
          return []};
        
        var current = 0,
            number  = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(number, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

        self.$each._p = function() {
          result.push((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments));

          if (number <= ++current) {
            return $breaker;
          }
        };

        self.$each();
      ;
      };
      return result;
    };

    $opal.defn(self, '$flat_map', def.$collect_concat);

    def.$grep = TMP_18 = function(pattern) {
      var $a, self = this, $iter = TMP_18._p, block = $iter || nil;

      TMP_18._p = null;
      
      var result = [];

      if (block !== nil) {
        self.$each._p = function() {
          var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
              value = pattern['$==='](param);

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            value = $opal.$yield1(block, param);

            if (value === $breaker) {
              result = $breaker.$v;
              return $breaker;
            }

            result.push(value);
          }
        };
      }
      else {
        self.$each._p = function() {
          var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
              value = pattern['$==='](param);

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            result.push(param);
          }
        };
      }

      self.$each();

      return result;
    ;
    };

    def.$group_by = TMP_19 = function() {
      var $a, $b, $c, self = this, $iter = TMP_19._p, block = $iter || nil, hash = nil;

      TMP_19._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("group_by")
      };
      hash = (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a).$new();
      
      var result;

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = $opal.$yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        (($a = value, $b = hash, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, []))))['$<<'](param);
      }

      self.$each();

      if (result !== undefined) {
        return result;
      }
    
      return hash;
    };

    def['$include?'] = function(obj) {
      var $a, self = this;

      
      var result = false;

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

        if ((param)['$=='](obj)) {
          result = true;
          return $breaker;
        }
      }

      self.$each();

      return result;
    
    };

    def.$inject = TMP_20 = function(object, sym) {
      var $a, self = this, $iter = TMP_20._p, block = $iter || nil;

      TMP_20._p = null;
      
      var result = object;

      if (block !== nil && sym === undefined) {
        self.$each._p = function() {
          var value = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if (result === undefined) {
            result = value;
            return;
          }

          value = $opal.$yieldX(block, [result, value]);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          result = value;
        };
      }
      else {
        if (sym === undefined) {
          if (!(($a = $scope.Symbol) == null ? $opal.cm('Symbol') : $a)['$==='](object)) {
            self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "" + (object.$inspect()) + " is not a Symbol");
          }

          sym    = object;
          result = undefined;
        }

        self.$each._p = function() {
          var value = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if (result === undefined) {
            result = value;
            return;
          }

          result = (result).$__send__(sym, value);
        };
      }

      self.$each();

      return result == undefined ? nil : result;
    ;
    };

    def.$lazy = function() {
      var $a, $b, TMP_21, $c, $d, self = this;

      return ($a = ($b = (($c = ((($d = $scope.Enumerator) == null ? $opal.cm('Enumerator') : $d))._scope).Lazy == null ? $c.cm('Lazy') : $c.Lazy)).$new, $a._p = (TMP_21 = function(enum$, args){var self = TMP_21._s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
      return ($a = enum$).$yield.apply($a, [].concat(args))}, TMP_21._s = self, TMP_21), $a).call($b, self, self.$enumerator_size());
    };

    def.$enumerator_size = function() {
      var $a, self = this;

      if ((($a = self['$respond_to?']("size")) !== nil && (!$a._isBoolean || $a == true))) {
        return self.$size()
        } else {
        return nil
      };
    };

    self.$private("enumerator_size");

    $opal.defn(self, '$map', def.$collect);

    def.$max = TMP_22 = function() {
      var $a, self = this, $iter = TMP_22._p, block = $iter || nil;

      TMP_22._p = null;
      
      var result;

      if (block !== nil) {
        self.$each._p = function() {
          var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          var value = block(param, result);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if (value === nil) {
            self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison failed");
          }

          if (value > 0) {
            result = param;
          }
        };
      }
      else {
        self.$each._p = function() {
          var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          if ((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$compare(param, result) > 0) {
            result = param;
          }
        };
      }

      self.$each();

      return result === undefined ? nil : result;
    
    };

    def.$max_by = TMP_23 = function() {
      var $a, self = this, $iter = TMP_23._p, block = $iter || nil;

      TMP_23._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("max_by")
      };
      
      var result,
          by;

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = $opal.$yield1(block, param);

        if (result === undefined) {
          result = param;
          by     = value;
          return;
        }

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((value)['$<=>'](by) > 0) {
          result = param
          by     = value;
        }
      };

      self.$each();

      return result === undefined ? nil : result;
    
    };

    $opal.defn(self, '$member?', def['$include?']);

    def.$min = TMP_24 = function() {
      var $a, self = this, $iter = TMP_24._p, block = $iter || nil;

      TMP_24._p = null;
      
      var result;

      if (block !== nil) {
        self.$each._p = function() {
          var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          var value = block(param, result);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if (value === nil) {
            self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison failed");
          }

          if (value < 0) {
            result = param;
          }
        };
      }
      else {
        self.$each._p = function() {
          var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          if ((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$compare(param, result) < 0) {
            result = param;
          }
        };
      }

      self.$each();

      return result === undefined ? nil : result;
    
    };

    def.$min_by = TMP_25 = function() {
      var $a, self = this, $iter = TMP_25._p, block = $iter || nil;

      TMP_25._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("min_by")
      };
      
      var result,
          by;

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = $opal.$yield1(block, param);

        if (result === undefined) {
          result = param;
          by     = value;
          return;
        }

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((value)['$<=>'](by) < 0) {
          result = param
          by     = value;
        }
      };

      self.$each();

      return result === undefined ? nil : result;
    
    };

    def.$minmax = TMP_26 = function() {
      var $a, self = this, $iter = TMP_26._p, block = $iter || nil;

      TMP_26._p = null;
      return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
    };

    def.$minmax_by = TMP_27 = function() {
      var $a, self = this, $iter = TMP_27._p, block = $iter || nil;

      TMP_27._p = null;
      return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
    };

    def['$none?'] = TMP_28 = function() {
      var $a, self = this, $iter = TMP_28._p, block = $iter || nil;

      TMP_28._p = null;
      
      var result = true;

      if (block !== nil) {
        self.$each._p = function() {
          var value = $opal.$yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            result = false;
            return $breaker;
          }
        }
      }
      else {
        self.$each._p = function() {
          var value = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            result = false;
            return $breaker;
          }
        };
      }

      self.$each();

      return result;
    
    };

    def['$one?'] = TMP_29 = function() {
      var $a, self = this, $iter = TMP_29._p, block = $iter || nil;

      TMP_29._p = null;
      
      var result = false;

      if (block !== nil) {
        self.$each._p = function() {
          var value = $opal.$yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            if (result === true) {
              result = false;
              return $breaker;
            }

            result = true;
          }
        }
      }
      else {
        self.$each._p = function() {
          var value = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            if (result === true) {
              result = false;
              return $breaker;
            }

            result = true;
          }
        }
      }

      self.$each();

      return result;
    
    };

    def.$partition = TMP_30 = function() {
      var $a, self = this, $iter = TMP_30._p, block = $iter || nil;

      TMP_30._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("partition")
      };
      
      var truthy = [], falsy = [];

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = $opal.$yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
          truthy.push(param);
        }
        else {
          falsy.push(param);
        }
      };

      self.$each();

      return [truthy, falsy];
    
    };

    $opal.defn(self, '$reduce', def.$inject);

    def.$reject = TMP_31 = function() {
      var $a, self = this, $iter = TMP_31._p, block = $iter || nil;

      TMP_31._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reject")
      };
      
      var result = [];

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = $opal.$yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) === nil || ($a._isBoolean && $a == false))) {
          result.push(param);
        }
      };

      self.$each();

      return result;
    
    };

    def.$reverse_each = TMP_32 = function() {
      var self = this, $iter = TMP_32._p, block = $iter || nil;

      TMP_32._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reverse_each")
      };
      
      var result = [];

      self.$each._p = function() {
        result.push(arguments);
      };

      self.$each();

      for (var i = result.length - 1; i >= 0; i--) {
        $opal.$yieldX(block, result[i]);
      }

      return result;
    
    };

    $opal.defn(self, '$select', def.$find_all);

    def.$slice_before = TMP_33 = function(pattern) {
      var $a, $b, TMP_34, $c, self = this, $iter = TMP_33._p, block = $iter || nil;

      TMP_33._p = null;
      if ((($a = pattern === undefined && block === nil || arguments.length > 1) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "wrong number of arguments (" + (arguments.length) + " for 1)")};
      return ($a = ($b = (($c = $scope.Enumerator) == null ? $opal.cm('Enumerator') : $c)).$new, $a._p = (TMP_34 = function(e){var self = TMP_34._s || this, $a;
if (e == null) e = nil;
      
        var slice = [];

        if (block !== nil) {
          if (pattern === undefined) {
            self.$each._p = function() {
              var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
                  value = $opal.$yield1(block, param);

              if ((($a = value) !== nil && (!$a._isBoolean || $a == true)) && slice.length > 0) {
                e['$<<'](slice);
                slice = [];
              }

              slice.push(param);
            };
          }
          else {
            self.$each._p = function() {
              var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
                  value = block(param, pattern.$dup());

              if ((($a = value) !== nil && (!$a._isBoolean || $a == true)) && slice.length > 0) {
                e['$<<'](slice);
                slice = [];
              }

              slice.push(param);
            };
          }
        }
        else {
          self.$each._p = function() {
            var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
                value = pattern['$==='](param);

            if ((($a = value) !== nil && (!$a._isBoolean || $a == true)) && slice.length > 0) {
              e['$<<'](slice);
              slice = [];
            }

            slice.push(param);
          };
        }

        self.$each();

        if (slice.length > 0) {
          e['$<<'](slice);
        }
      ;}, TMP_34._s = self, TMP_34), $a).call($b);
    };

    def.$sort = TMP_35 = function() {
      var $a, self = this, $iter = TMP_35._p, block = $iter || nil;

      TMP_35._p = null;
      return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
    };

    def.$sort_by = TMP_36 = function() {
      var $a, $b, TMP_37, $c, $d, TMP_38, $e, $f, TMP_39, self = this, $iter = TMP_36._p, block = $iter || nil;

      TMP_36._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("sort_by")
      };
      return ($a = ($b = ($c = ($d = ($e = ($f = self).$map, $e._p = (TMP_39 = function(){var self = TMP_39._s || this, $a;

      arg = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments);
        return [block.$call(arg), arg];}, TMP_39._s = self, TMP_39), $e).call($f)).$sort, $c._p = (TMP_38 = function(a, b){var self = TMP_38._s || this;
if (a == null) a = nil;if (b == null) b = nil;
      return a['$[]'](0)['$<=>'](b['$[]'](0))}, TMP_38._s = self, TMP_38), $c).call($d)).$map, $a._p = (TMP_37 = function(arg){var self = TMP_37._s || this;
if (arg == null) arg = nil;
      return arg[1];}, TMP_37._s = self, TMP_37), $a).call($b);
    };

    def.$take = function(num) {
      var self = this;

      return self.$first(num);
    };

    def.$take_while = TMP_40 = function() {
      var $a, self = this, $iter = TMP_40._p, block = $iter || nil;

      TMP_40._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("take_while")
      };
      
      var result = [];

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = $opal.$yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) === nil || ($a._isBoolean && $a == false))) {
          return $breaker;
        }

        result.push(param);
      };

      self.$each();

      return result;
    
    };

    $opal.defn(self, '$to_a', def.$entries);

    def.$zip = TMP_41 = function(others) {
      var $a, self = this, $iter = TMP_41._p, block = $iter || nil;

      others = $slice.call(arguments, 0);
      TMP_41._p = null;
      return ($a = self.$to_a()).$zip.apply($a, [].concat(others));
    };
        ;$opal.donate(self, ["$all?", "$any?", "$chunk", "$collect", "$collect_concat", "$count", "$cycle", "$detect", "$drop", "$drop_while", "$each_cons", "$each_entry", "$each_slice", "$each_with_index", "$each_with_object", "$entries", "$find", "$find_all", "$find_index", "$first", "$flat_map", "$grep", "$group_by", "$include?", "$inject", "$lazy", "$enumerator_size", "$map", "$max", "$max_by", "$member?", "$min", "$min_by", "$minmax", "$minmax_by", "$none?", "$one?", "$partition", "$reduce", "$reject", "$reverse_each", "$select", "$slice_before", "$sort", "$sort_by", "$take", "$take_while", "$to_a", "$zip"]);
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$allocate', '$new', '$to_proc', '$coerce_to', '$nil?', '$empty?', '$+', '$class', '$__send__', '$===', '$call', '$enum_for', '$destructure', '$name', '$inspect', '$[]', '$raise', '$yield', '$each', '$enumerator_size', '$respond_to?', '$try_convert', '$<', '$for']);
  ;
  return (function($base, $super) {
    function $Enumerator(){};
    var self = $Enumerator = $klass($base, $super, 'Enumerator', $Enumerator);

    var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2, TMP_3, TMP_4;

    def.size = def.args = def.object = def.method = nil;
    self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

    $opal.defs(self, '$for', TMP_1 = function(object, method, args) {
      var self = this, $iter = TMP_1._p, block = $iter || nil;

      args = $slice.call(arguments, 2);
      if (method == null) {
        method = "each"
      }
      TMP_1._p = null;
      
      var obj = self.$allocate();

      obj.object = object;
      obj.size   = block;
      obj.method = method;
      obj.args   = args;

      return obj;
    ;
    });

    def.$initialize = TMP_2 = function() {
      var $a, $b, $c, self = this, $iter = TMP_2._p, block = $iter || nil;

      TMP_2._p = null;
      if (block !== false && block !== nil) {
        self.object = ($a = ($b = (($c = $scope.Generator) == null ? $opal.cm('Generator') : $c)).$new, $a._p = block.$to_proc(), $a).call($b);
        self.method = "each";
        self.args = [];
        self.size = arguments[0] || nil;
        if ((($a = self.size) !== nil && (!$a._isBoolean || $a == true))) {
          return self.size = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(self.size, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")
          } else {
          return nil
        };
        } else {
        self.object = arguments[0];
        self.method = arguments[1] || "each";
        self.args = $slice.call(arguments, 2);
        return self.size = nil;
      };
    };

    def.$each = TMP_3 = function(args) {
      var $a, $b, $c, self = this, $iter = TMP_3._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_3._p = null;
      if ((($a = ($b = block['$nil?'](), $b !== false && $b !== nil ?args['$empty?']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return self};
      args = self.args['$+'](args);
      if ((($a = block['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
        return ($a = self.$class()).$new.apply($a, [self.object, self.method].concat(args))};
      return ($b = ($c = self.object).$__send__, $b._p = block.$to_proc(), $b).apply($c, [self.method].concat(args));
    };

    def.$size = function() {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Proc) == null ? $opal.cm('Proc') : $b)['$==='](self.size)) !== nil && (!$a._isBoolean || $a == true))) {
        return ($a = self.size).$call.apply($a, [].concat(self.args))
        } else {
        return self.size
      };
    };

    def.$with_index = TMP_4 = function(offset) {
      var $a, self = this, $iter = TMP_4._p, block = $iter || nil;

      if (offset == null) {
        offset = 0
      }
      TMP_4._p = null;
      if (offset !== false && offset !== nil) {
        offset = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(offset, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")
        } else {
        offset = 0
      };
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("with_index", offset)
      };
      
      var result

      self.$each._p = function() {
        var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(arguments),
            value = block(param, index);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        index++;
      }

      self.$each();

      if (result !== undefined) {
        return result;
      }
    ;
    };

    $opal.defn(self, '$with_object', def.$each_with_object);

    def.$inspect = function() {
      var $a, self = this, result = nil;

      result = "#<" + (self.$class().$name()) + ": " + (self.object.$inspect()) + ":" + (self.method);
      if ((($a = self.args['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        result = result['$+']("(" + (self.args.$inspect()['$[]']((($a = $scope.Range) == null ? $opal.cm('Range') : $a).$new(1, -2))) + ")")
      };
      return result['$+'](">");
    };

    (function($base, $super) {
      function $Generator(){};
      var self = $Generator = $klass($base, $super, 'Generator', $Generator);

      var def = self._proto, $scope = self._scope, $a, TMP_5, TMP_6;

      def.block = nil;
      self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

      def.$initialize = TMP_5 = function() {
        var $a, self = this, $iter = TMP_5._p, block = $iter || nil;

        TMP_5._p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise((($a = $scope.LocalJumpError) == null ? $opal.cm('LocalJumpError') : $a), "no block given")
        };
        return self.block = block;
      };

      return (def.$each = TMP_6 = function(args) {
        var $a, $b, $c, self = this, $iter = TMP_6._p, block = $iter || nil, yielder = nil;

        args = $slice.call(arguments, 0);
        TMP_6._p = null;
        yielder = ($a = ($b = (($c = $scope.Yielder) == null ? $opal.cm('Yielder') : $c)).$new, $a._p = block.$to_proc(), $a).call($b);
        
        try {
          args.unshift(yielder);

          if ($opal.$yieldX(self.block, args) === $breaker) {
            return $breaker.$v;
          }
        }
        catch (e) {
          if (e === $breaker) {
            return $breaker.$v;
          }
          else {
            throw e;
          }
        }
      ;
        return self;
      }, nil) && 'each';
    })(self, null);

    (function($base, $super) {
      function $Yielder(){};
      var self = $Yielder = $klass($base, $super, 'Yielder', $Yielder);

      var def = self._proto, $scope = self._scope, TMP_7;

      def.block = nil;
      def.$initialize = TMP_7 = function() {
        var self = this, $iter = TMP_7._p, block = $iter || nil;

        TMP_7._p = null;
        return self.block = block;
      };

      def.$yield = function(values) {
        var self = this;

        values = $slice.call(arguments, 0);
        
        var value = $opal.$yieldX(self.block, values);

        if (value === $breaker) {
          throw $breaker;
        }

        return value;
      ;
      };

      return (def['$<<'] = function(values) {
        var $a, self = this;

        values = $slice.call(arguments, 0);
        ($a = self).$yield.apply($a, [].concat(values));
        return self;
      }, nil) && '<<';
    })(self, null);

    return (function($base, $super) {
      function $Lazy(){};
      var self = $Lazy = $klass($base, $super, 'Lazy', $Lazy);

      var def = self._proto, $scope = self._scope, $a, TMP_8, TMP_11, TMP_13, TMP_18, TMP_20, TMP_21, TMP_23, TMP_26, TMP_29;

      def.enumerator = nil;
      (function($base, $super) {
        function $StopLazyError(){};
        var self = $StopLazyError = $klass($base, $super, 'StopLazyError', $StopLazyError);

        var def = self._proto, $scope = self._scope;

        return nil;
      })(self, (($a = $scope.Exception) == null ? $opal.cm('Exception') : $a));

      def.$initialize = TMP_8 = function(object, size) {
        var $a, TMP_9, self = this, $iter = TMP_8._p, block = $iter || nil;

        if (size == null) {
          size = nil
        }
        TMP_8._p = null;
        if ((block !== nil)) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to call lazy new without a block")
        };
        self.enumerator = object;
        return $opal.find_super_dispatcher(self, 'initialize', TMP_8, (TMP_9 = function(yielder, each_args){var self = TMP_9._s || this, $a, $b, TMP_10;
if (yielder == null) yielder = nil;each_args = $slice.call(arguments, 1);
        try {
          return ($a = ($b = object).$each, $a._p = (TMP_10 = function(args){var self = TMP_10._s || this;
args = $slice.call(arguments, 0);
            
              args.unshift(yielder);

              if ($opal.$yieldX(block, args) === $breaker) {
                return $breaker;
              }
            ;}, TMP_10._s = self, TMP_10), $a).apply($b, [].concat(each_args))
          } catch ($err) {if ($opal.$rescue($err, [(($a = $scope.Exception) == null ? $opal.cm('Exception') : $a)])) {
            return nil
            }else { throw $err; }
          }}, TMP_9._s = self, TMP_9)).apply(self, [size]);
      };

      $opal.defn(self, '$force', def.$to_a);

      def.$lazy = function() {
        var self = this;

        return self;
      };

      def.$collect = TMP_11 = function() {
        var $a, $b, TMP_12, $c, self = this, $iter = TMP_11._p, block = $iter || nil;

        TMP_11._p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to call lazy map without a block")
        };
        return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_12 = function(enum$, args){var self = TMP_12._s || this;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = $opal.$yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          enum$.$yield(value);
        }, TMP_12._s = self, TMP_12), $a).call($b, self, self.$enumerator_size());
      };

      def.$collect_concat = TMP_13 = function() {
        var $a, $b, TMP_14, $c, self = this, $iter = TMP_13._p, block = $iter || nil;

        TMP_13._p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to call lazy map without a block")
        };
        return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_14 = function(enum$, args){var self = TMP_14._s || this, $a, $b, TMP_15, $c, TMP_16;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = $opal.$yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          if ((value)['$respond_to?']("force") && (value)['$respond_to?']("each")) {
            ($a = ($b = (value)).$each, $a._p = (TMP_15 = function(v){var self = TMP_15._s || this;
if (v == null) v = nil;
          return enum$.$yield(v)}, TMP_15._s = self, TMP_15), $a).call($b)
          }
          else {
            var array = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$try_convert(value, (($a = $scope.Array) == null ? $opal.cm('Array') : $a), "to_ary");

            if (array === nil) {
              enum$.$yield(value);
            }
            else {
              ($a = ($c = (value)).$each, $a._p = (TMP_16 = function(v){var self = TMP_16._s || this;
if (v == null) v = nil;
          return enum$.$yield(v)}, TMP_16._s = self, TMP_16), $a).call($c);
            }
          }
        ;}, TMP_14._s = self, TMP_14), $a).call($b, self, nil);
      };

      def.$drop = function(n) {
        var $a, $b, TMP_17, $c, self = this, current_size = nil, set_size = nil, dropped = nil;

        n = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(n, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        if (n['$<'](0)) {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "attempt to drop negative size")};
        current_size = self.$enumerator_size();
        set_size = (function() {if ((($a = (($b = $scope.Integer) == null ? $opal.cm('Integer') : $b)['$==='](current_size)) !== nil && (!$a._isBoolean || $a == true))) {
          if (n['$<'](current_size)) {
            return n
            } else {
            return current_size
          }
          } else {
          return current_size
        }; return nil; })();
        dropped = 0;
        return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_17 = function(enum$, args){var self = TMP_17._s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        if (dropped['$<'](n)) {
            return dropped = dropped['$+'](1)
            } else {
            return ($a = enum$).$yield.apply($a, [].concat(args))
          }}, TMP_17._s = self, TMP_17), $a).call($b, self, set_size);
      };

      def.$drop_while = TMP_18 = function() {
        var $a, $b, TMP_19, $c, self = this, $iter = TMP_18._p, block = $iter || nil, succeeding = nil;

        TMP_18._p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to call lazy drop_while without a block")
        };
        succeeding = true;
        return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_19 = function(enum$, args){var self = TMP_19._s || this, $a, $b;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        if (succeeding !== false && succeeding !== nil) {
            
            var value = $opal.$yieldX(block, args);

            if (value === $breaker) {
              return $breaker;
            }

            if ((($a = value) === nil || ($a._isBoolean && $a == false))) {
              succeeding = false;

              ($a = enum$).$yield.apply($a, [].concat(args));
            }
          
            } else {
            return ($b = enum$).$yield.apply($b, [].concat(args))
          }}, TMP_19._s = self, TMP_19), $a).call($b, self, nil);
      };

      def.$enum_for = TMP_20 = function(method, args) {
        var $a, $b, self = this, $iter = TMP_20._p, block = $iter || nil;

        args = $slice.call(arguments, 1);
        if (method == null) {
          method = "each"
        }
        TMP_20._p = null;
        return ($a = ($b = self.$class()).$for, $a._p = block.$to_proc(), $a).apply($b, [self, method].concat(args));
      };

      def.$find_all = TMP_21 = function() {
        var $a, $b, TMP_22, $c, self = this, $iter = TMP_21._p, block = $iter || nil;

        TMP_21._p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to call lazy select without a block")
        };
        return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_22 = function(enum$, args){var self = TMP_22._s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = $opal.$yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            ($a = enum$).$yield.apply($a, [].concat(args));
          }
        ;}, TMP_22._s = self, TMP_22), $a).call($b, self, nil);
      };

      $opal.defn(self, '$flat_map', def.$collect_concat);

      def.$grep = TMP_23 = function(pattern) {
        var $a, $b, TMP_24, $c, TMP_25, $d, self = this, $iter = TMP_23._p, block = $iter || nil;

        TMP_23._p = null;
        if (block !== false && block !== nil) {
          return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_24 = function(enum$, args){var self = TMP_24._s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
          
            var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(args),
                value = pattern['$==='](param);

            if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
              value = $opal.$yield1(block, param);

              if (value === $breaker) {
                return $breaker;
              }

              enum$.$yield($opal.$yield1(block, param));
            }
          ;}, TMP_24._s = self, TMP_24), $a).call($b, self, nil)
          } else {
          return ($a = ($c = (($d = $scope.Lazy) == null ? $opal.cm('Lazy') : $d)).$new, $a._p = (TMP_25 = function(enum$, args){var self = TMP_25._s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
          
            var param = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$destructure(args),
                value = pattern['$==='](param);

            if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
              enum$.$yield(param);
            }
          ;}, TMP_25._s = self, TMP_25), $a).call($c, self, nil)
        };
      };

      $opal.defn(self, '$map', def.$collect);

      $opal.defn(self, '$select', def.$find_all);

      def.$reject = TMP_26 = function() {
        var $a, $b, TMP_27, $c, self = this, $iter = TMP_26._p, block = $iter || nil;

        TMP_26._p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to call lazy reject without a block")
        };
        return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_27 = function(enum$, args){var self = TMP_27._s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = $opal.$yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          if ((($a = value) === nil || ($a._isBoolean && $a == false))) {
            ($a = enum$).$yield.apply($a, [].concat(args));
          }
        ;}, TMP_27._s = self, TMP_27), $a).call($b, self, nil);
      };

      def.$take = function(n) {
        var $a, $b, TMP_28, $c, self = this, current_size = nil, set_size = nil, taken = nil;

        n = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(n, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        if (n['$<'](0)) {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "attempt to take negative size")};
        current_size = self.$enumerator_size();
        set_size = (function() {if ((($a = (($b = $scope.Integer) == null ? $opal.cm('Integer') : $b)['$==='](current_size)) !== nil && (!$a._isBoolean || $a == true))) {
          if (n['$<'](current_size)) {
            return n
            } else {
            return current_size
          }
          } else {
          return current_size
        }; return nil; })();
        taken = 0;
        return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_28 = function(enum$, args){var self = TMP_28._s || this, $a, $b;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        if (taken['$<'](n)) {
            ($a = enum$).$yield.apply($a, [].concat(args));
            return taken = taken['$+'](1);
            } else {
            return self.$raise((($b = $scope.StopLazyError) == null ? $opal.cm('StopLazyError') : $b))
          }}, TMP_28._s = self, TMP_28), $a).call($b, self, set_size);
      };

      def.$take_while = TMP_29 = function() {
        var $a, $b, TMP_30, $c, self = this, $iter = TMP_29._p, block = $iter || nil;

        TMP_29._p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to call lazy take_while without a block")
        };
        return ($a = ($b = (($c = $scope.Lazy) == null ? $opal.cm('Lazy') : $c)).$new, $a._p = (TMP_30 = function(enum$, args){var self = TMP_30._s || this, $a, $b;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = $opal.$yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a._isBoolean || $a == true))) {
            ($a = enum$).$yield.apply($a, [].concat(args));
          }
          else {
            self.$raise((($b = $scope.StopLazyError) == null ? $opal.cm('StopLazyError') : $b));
          }
        ;}, TMP_30._s = self, TMP_30), $a).call($b, self, nil);
      };

      $opal.defn(self, '$to_enum', def.$enum_for);

      return (def.$inspect = function() {
        var self = this;

        return "#<" + (self.$class().$name()) + ": " + (self.enumerator.$inspect()) + ">";
      }, nil) && 'inspect';
    })(self, self);
  })(self, null);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $gvars = $opal.gvars, $range = $opal.range;

  $opal.add_stubs(['$include', '$new', '$class', '$raise', '$===', '$to_a', '$respond_to?', '$to_ary', '$coerce_to', '$coerce_to?', '$==', '$to_str', '$clone', '$hash', '$<=>', '$inspect', '$empty?', '$enum_for', '$nil?', '$coerce_to!', '$initialize_clone', '$initialize_dup', '$replace', '$eql?', '$length', '$begin', '$end', '$exclude_end?', '$flatten', '$object_id', '$[]', '$to_s', '$join', '$delete_if', '$to_proc', '$each', '$reverse', '$!', '$map', '$rand', '$keep_if', '$shuffle!', '$>', '$<', '$sort', '$times', '$[]=', '$<<', '$at']);
  ;
  return (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_17, TMP_18, TMP_19, TMP_20, TMP_21, TMP_24;

    def.length = nil;
    self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

    def._isArray = true;

    $opal.defs(self, '$[]', function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      return objects;
    });

    def.$initialize = function(args) {
      var $a, self = this;

      args = $slice.call(arguments, 0);
      return ($a = self.$class()).$new.apply($a, [].concat(args));
    };

    $opal.defs(self, '$new', TMP_1 = function(size, obj) {
      var $a, $b, self = this, $iter = TMP_1._p, block = $iter || nil;

      if (size == null) {
        size = nil
      }
      if (obj == null) {
        obj = nil
      }
      TMP_1._p = null;
      if ((($a = arguments.length > 2) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "wrong number of arguments (" + (arguments.length) + " for 0..2)")};
      if ((($a = arguments.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
        return []};
      if ((($a = arguments.length === 1) !== nil && (!$a._isBoolean || $a == true))) {
        if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](size)) !== nil && (!$a._isBoolean || $a == true))) {
          return size.$to_a()
        } else if ((($a = size['$respond_to?']("to_ary")) !== nil && (!$a._isBoolean || $a == true))) {
          return size.$to_ary()}};
      size = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(size, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      if ((($a = size < 0) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "negative array size")};
      
      var result = [];

      if (block === nil) {
        for (var i = 0; i < size; i++) {
          result.push(obj);
        }
      }
      else {
        for (var i = 0, value; i < size; i++) {
          value = block(i);

          if (value === $breaker) {
            return $breaker.$v;
          }

          result[i] = value;
        }
      }

      return result;
    
    });

    $opal.defs(self, '$try_convert', function(obj) {
      var $a, self = this;

      return (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to?'](obj, (($a = $scope.Array) == null ? $opal.cm('Array') : $a), "to_ary");
    });

    def['$&'] = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.Array) == null ? $opal.cm('Array') : $a), "to_ary").$to_a()
      };
      
      var result = [],
          seen   = {};

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if (!seen[item]) {
          for (var j = 0, length2 = other.length; j < length2; j++) {
            var item2 = other[j];

            if (!seen[item2] && (item)['$=='](item2)) {
              seen[item] = true;
              result.push(item);
            }
          }
        }
      }

      return result;
    
    };

    def['$*'] = function(other) {
      var $a, self = this;

      if ((($a = other['$respond_to?']("to_str")) !== nil && (!$a._isBoolean || $a == true))) {
        return self.join(other.$to_str())};
      if ((($a = other['$respond_to?']("to_int")) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "no implicit conversion of " + (other.$class()) + " into Integer")
      };
      other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      if ((($a = other < 0) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "negative argument")};
      
      var result = [];

      for (var i = 0; i < other; i++) {
        result = result.concat(self);
      }

      return result;
    
    };

    def['$+'] = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.Array) == null ? $opal.cm('Array') : $a), "to_ary").$to_a()
      };
      return self.concat(other);
    };

    def['$-'] = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.Array) == null ? $opal.cm('Array') : $a), "to_ary").$to_a()
      };
      if ((($a = self.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
        return []};
      if ((($a = other.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
        return self.$clone()};
      
      var seen   = {},
          result = [];

      for (var i = 0, length = other.length; i < length; i++) {
        seen[other[i]] = true;
      }

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if (!seen[item]) {
          result.push(item);
        }
      }

      return result;
    
    };

    def['$<<'] = function(object) {
      var self = this;

      self.push(object);
      return self;
    };

    def['$<=>'] = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        other = other.$to_a()
      } else if ((($a = other['$respond_to?']("to_ary")) !== nil && (!$a._isBoolean || $a == true))) {
        other = other.$to_ary().$to_a()
        } else {
        return nil
      };
      
      if (self.$hash() === other.$hash()) {
        return 0;
      }

      if (self.length != other.length) {
        return (self.length > other.length) ? 1 : -1;
      }

      for (var i = 0, length = self.length; i < length; i++) {
        var tmp = (self[i])['$<=>'](other[i]);

        if (tmp !== 0) {
          return tmp;
        }
      }

      return 0;
    ;
    };

    def['$=='] = function(other) {
      var $a, $b, self = this;

      if ((($a = self === other) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        if ((($a = other['$respond_to?']("to_ary")) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          return false
        };
        return other['$=='](self);
      };
      other = other.$to_a();
      if ((($a = self.length === other.length) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var a = self[i],
            b = other[i];

        if (a._isArray && b._isArray && (a === self)) {
          continue;
        }

        if (!(a)['$=='](b)) {
          return false;
        }
      }
    
      return true;
    };

    def['$[]'] = function(index, length) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Range) == null ? $opal.cm('Range') : $b)['$==='](index)) !== nil && (!$a._isBoolean || $a == true))) {
        
        var size    = self.length,
            exclude = index.exclude,
            from    = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index.begin, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int"),
            to      = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index.end, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

        if (from < 0) {
          from += size;

          if (from < 0) {
            return nil;
          }
        }

        if (from > size) {
          return nil;
        }

        if (to < 0) {
          to += size;

          if (to < 0) {
            return [];
          }
        }

        if (!exclude) {
          to += 1;
        }

        return self.slice(from, to);
      ;
        } else {
        index = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        
        var size = self.length;

        if (index < 0) {
          index += size;

          if (index < 0) {
            return nil;
          }
        }

        if (length === undefined) {
          if (index >= size || index < 0) {
            return nil;
          }

          return self[index];
        }
        else {
          length = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(length, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

          if (length < 0 || index > size || index < 0) {
            return nil;
          }

          return self.slice(index, index + length);
        }
      
      };
    };

    def['$[]='] = function(index, value, extra) {
      var $a, $b, self = this, data = nil, length = nil;

      if ((($a = (($b = $scope.Range) == null ? $opal.cm('Range') : $b)['$==='](index)) !== nil && (!$a._isBoolean || $a == true))) {
        if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](value)) !== nil && (!$a._isBoolean || $a == true))) {
          data = value.$to_a()
        } else if ((($a = value['$respond_to?']("to_ary")) !== nil && (!$a._isBoolean || $a == true))) {
          data = value.$to_ary().$to_a()
          } else {
          data = [value]
        };
        
        var size    = self.length,
            exclude = index.exclude,
            from    = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index.begin, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int"),
            to      = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index.end, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

        if (from < 0) {
          from += size;

          if (from < 0) {
            self.$raise((($a = $scope.RangeError) == null ? $opal.cm('RangeError') : $a), "" + (index.$inspect()) + " out of range");
          }
        }

        if (to < 0) {
          to += size;
        }

        if (!exclude) {
          to += 1;
        }

        if (from > size) {
          for (var i = size; i < from; i++) {
            self[i] = nil;
          }
        }

        if (to < 0) {
          self.splice.apply(self, [from, 0].concat(data));
        }
        else {
          self.splice.apply(self, [from, to - from].concat(data));
        }

        return value;
      ;
        } else {
        if ((($a = extra === undefined) !== nil && (!$a._isBoolean || $a == true))) {
          length = 1
          } else {
          length = value;
          value = extra;
          if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](value)) !== nil && (!$a._isBoolean || $a == true))) {
            data = value.$to_a()
          } else if ((($a = value['$respond_to?']("to_ary")) !== nil && (!$a._isBoolean || $a == true))) {
            data = value.$to_ary().$to_a()
            } else {
            data = [value]
          };
        };
        
        var size   = self.length,
            index  = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int"),
            length = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(length, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int"),
            old;

        if (index < 0) {
          old    = index;
          index += size;

          if (index < 0) {
            self.$raise((($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a), "index " + (old) + " too small for array; minimum " + (-self.length));
          }
        }

        if (length < 0) {
          self.$raise((($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a), "negative length (" + (length) + ")")
        }

        if (index > size) {
          for (var i = size; i < index; i++) {
            self[i] = nil;
          }
        }

        if (extra === undefined) {
          self[index] = value;
        }
        else {
          self.splice.apply(self, [index, length].concat(data));
        }

        return value;
      ;
      };
    };

    def.$assoc = function(object) {
      var self = this;

      
      for (var i = 0, length = self.length, item; i < length; i++) {
        if (item = self[i], item.length && (item[0])['$=='](object)) {
          return item;
        }
      }

      return nil;
    
    };

    def.$at = function(index) {
      var $a, self = this;

      index = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      
      if (index < 0) {
        index += self.length;
      }

      if (index < 0 || index >= self.length) {
        return nil;
      }

      return self[index];
    
    };

    def.$cycle = TMP_2 = function(n) {
      var $a, $b, self = this, $iter = TMP_2._p, block = $iter || nil;

      if (n == null) {
        n = nil
      }
      TMP_2._p = null;
      if ((($a = ((($b = self['$empty?']()) !== false && $b !== nil) ? $b : n['$=='](0))) !== nil && (!$a._isBoolean || $a == true))) {
        return nil};
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("cycle", n)
      };
      if ((($a = n['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
        
        while (true) {
          for (var i = 0, length = self.length; i < length; i++) {
            var value = $opal.$yield1(block, self[i]);

            if (value === $breaker) {
              return $breaker.$v;
            }
          }
        }
      
        } else {
        n = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](n, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        
        if (n <= 0) {
          return self;
        }

        while (n > 0) {
          for (var i = 0, length = self.length; i < length; i++) {
            var value = $opal.$yield1(block, self[i]);

            if (value === $breaker) {
              return $breaker.$v;
            }
          }

          n--;
        }
      
      };
      return self;
    };

    def.$clear = function() {
      var self = this;

      self.splice(0, self.length);
      return self;
    };

    def.$clone = function() {
      var self = this, copy = nil;

      copy = [];
      copy.$initialize_clone(self);
      return copy;
    };

    def.$dup = function() {
      var self = this, copy = nil;

      copy = [];
      copy.$initialize_dup(self);
      return copy;
    };

    def.$initialize_copy = function(other) {
      var self = this;

      return self.$replace(other);
    };

    def.$collect = TMP_3 = function() {
      var self = this, $iter = TMP_3._p, block = $iter || nil;

      TMP_3._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("collect")
      };
      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        var value = Opal.$yield1(block, self[i]);

        if (value === $breaker) {
          return $breaker.$v;
        }

        result.push(value);
      }

      return result;
    
    };

    def['$collect!'] = TMP_4 = function() {
      var self = this, $iter = TMP_4._p, block = $iter || nil;

      TMP_4._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("collect!")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = Opal.$yield1(block, self[i]);

        if (value === $breaker) {
          return $breaker.$v;
        }

        self[i] = value;
      }
    
      return self;
    };

    def.$compact = function() {
      var self = this;

      
      var result = [];

      for (var i = 0, length = self.length, item; i < length; i++) {
        if ((item = self[i]) !== nil) {
          result.push(item);
        }
      }

      return result;
    
    };

    def['$compact!'] = function() {
      var self = this;

      
      var original = self.length;

      for (var i = 0, length = self.length; i < length; i++) {
        if (self[i] === nil) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }

      return self.length === original ? nil : self;
    
    };

    def.$concat = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.Array) == null ? $opal.cm('Array') : $a), "to_ary").$to_a()
      };
      
      for (var i = 0, length = other.length; i < length; i++) {
        self.push(other[i]);
      }
    
      return self;
    };

    def.$delete = function(object) {
      var self = this;

      
      var original = self.length;

      for (var i = 0, length = original; i < length; i++) {
        if ((self[i])['$=='](object)) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }

      return self.length === original ? nil : object;
    
    };

    def.$delete_at = function(index) {
      var $a, self = this;

      
      index = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

      if (index < 0) {
        index += self.length;
      }

      if (index < 0 || index >= self.length) {
        return nil;
      }

      var result = self[index];

      self.splice(index, 1);

      return result;
    ;
    };

    def.$delete_if = TMP_5 = function() {
      var self = this, $iter = TMP_5._p, block = $iter || nil;

      TMP_5._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("delete_if")
      };
      
      for (var i = 0, length = self.length, value; i < length; i++) {
        if ((value = block(self[i])) === $breaker) {
          return $breaker.$v;
        }

        if (value !== false && value !== nil) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }
    
      return self;
    };

    def.$drop = function(number) {
      var $a, self = this;

      
      if (number < 0) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a))
      }

      return self.slice(number);
    ;
    };

    $opal.defn(self, '$dup', def.$clone);

    def.$each = TMP_6 = function() {
      var self = this, $iter = TMP_6._p, block = $iter || nil;

      TMP_6._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = $opal.$yield1(block, self[i]);

        if (value == $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def.$each_index = TMP_7 = function() {
      var self = this, $iter = TMP_7._p, block = $iter || nil;

      TMP_7._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_index")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = $opal.$yield1(block, i);

        if (value === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def['$empty?'] = function() {
      var self = this;

      return self.length === 0;
    };

    def['$eql?'] = function(other) {
      var $a, $b, self = this;

      if ((($a = self === other) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      other = other.$to_a();
      if ((($a = self.length === other.length) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var a = self[i],
            b = other[i];

        if (a._isArray && b._isArray && (a === self)) {
          continue;
        }

        if (!(a)['$eql?'](b)) {
          return false;
        }
      }
    
      return true;
    };

    def.$fetch = TMP_8 = function(index, defaults) {
      var $a, self = this, $iter = TMP_8._p, block = $iter || nil;

      TMP_8._p = null;
      
      var original = index;

      index = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

      if (index < 0) {
        index += self.length;
      }

      if (index >= 0 && index < self.length) {
        return self[index];
      }

      if (block !== nil) {
        return block(original);
      }

      if (defaults != null) {
        return defaults;
      }

      if (self.length === 0) {
        self.$raise((($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a), "index " + (original) + " outside of array bounds: 0...0")
      }
      else {
        self.$raise((($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a), "index " + (original) + " outside of array bounds: -" + (self.length) + "..." + (self.length));
      }
    ;
    };

    def.$fill = TMP_9 = function(args) {
      var $a, $b, self = this, $iter = TMP_9._p, block = $iter || nil, one = nil, two = nil, obj = nil, left = nil, right = nil;

      args = $slice.call(arguments, 0);
      TMP_9._p = null;
      if (block !== false && block !== nil) {
        if ((($a = args.length > 2) !== nil && (!$a._isBoolean || $a == true))) {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "wrong number of arguments (" + (args.$length()) + " for 0..2)")};
        $a = $opal.to_ary(args), one = ($a[0] == null ? nil : $a[0]), two = ($a[1] == null ? nil : $a[1]);
        } else {
        if ((($a = args.length == 0) !== nil && (!$a._isBoolean || $a == true))) {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "wrong number of arguments (0 for 1..3)")
        } else if ((($a = args.length > 3) !== nil && (!$a._isBoolean || $a == true))) {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "wrong number of arguments (" + (args.$length()) + " for 1..3)")};
        $a = $opal.to_ary(args), obj = ($a[0] == null ? nil : $a[0]), one = ($a[1] == null ? nil : $a[1]), two = ($a[2] == null ? nil : $a[2]);
      };
      if ((($a = (($b = $scope.Range) == null ? $opal.cm('Range') : $b)['$==='](one)) !== nil && (!$a._isBoolean || $a == true))) {
        if (two !== false && two !== nil) {
          self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "length invalid with range")};
        left = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(one.$begin(), (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        if ((($a = left < 0) !== nil && (!$a._isBoolean || $a == true))) {
          left += self.length;};
        if ((($a = left < 0) !== nil && (!$a._isBoolean || $a == true))) {
          self.$raise((($a = $scope.RangeError) == null ? $opal.cm('RangeError') : $a), "" + (one.$inspect()) + " out of range")};
        right = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(one.$end(), (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        if ((($a = right < 0) !== nil && (!$a._isBoolean || $a == true))) {
          right += self.length;};
        if ((($a = one['$exclude_end?']()) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          right += 1;
        };
        if ((($a = right <= left) !== nil && (!$a._isBoolean || $a == true))) {
          return self};
      } else if (one !== false && one !== nil) {
        left = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(one, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        if ((($a = left < 0) !== nil && (!$a._isBoolean || $a == true))) {
          left += self.length;};
        if ((($a = left < 0) !== nil && (!$a._isBoolean || $a == true))) {
          left = 0};
        if (two !== false && two !== nil) {
          right = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(two, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
          if ((($a = right == 0) !== nil && (!$a._isBoolean || $a == true))) {
            return self};
          right += left;
          } else {
          right = self.length
        };
        } else {
        left = 0;
        right = self.length;
      };
      if ((($a = left > self.length) !== nil && (!$a._isBoolean || $a == true))) {
        
        for (var i = self.length; i < right; i++) {
          self[i] = nil;
        }
      ;};
      if ((($a = right > self.length) !== nil && (!$a._isBoolean || $a == true))) {
        self.length = right};
      if (block !== false && block !== nil) {
        
        for (var length = self.length; left < right; left++) {
          var value = block(left);

          if (value === $breaker) {
            return $breaker.$v;
          }

          self[left] = value;
        }
      ;
        } else {
        
        for (var length = self.length; left < right; left++) {
          self[left] = obj;
        }
      ;
      };
      return self;
    };

    def.$first = function(count) {
      var $a, self = this;

      
      if (count == null) {
        return self.length === 0 ? nil : self[0];
      }

      count = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(count, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

      if (count < 0) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "negative array size");
      }

      return self.slice(0, count);
    
    };

    def.$flatten = function(level) {
      var $a, self = this;

      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if ((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$respond_to?'](item, "to_ary")) {
          item = (item).$to_ary();

          if (level == null) {
            result.push.apply(result, (item).$flatten().$to_a());
          }
          else if (level == 0) {
            result.push(item);
          }
          else {
            result.push.apply(result, (item).$flatten(level - 1).$to_a());
          }
        }
        else {
          result.push(item);
        }
      }

      return result;
    ;
    };

    def['$flatten!'] = function(level) {
      var self = this;

      
      var flattened = self.$flatten(level);

      if (self.length == flattened.length) {
        for (var i = 0, length = self.length; i < length; i++) {
          if (self[i] !== flattened[i]) {
            break;
          }
        }

        if (i == length) {
          return nil;
        }
      }

      self.$replace(flattened);
    ;
      return self;
    };

    def.$hash = function() {
      var self = this;

      return self._id || (self._id = Opal.uid());
    };

    def['$include?'] = function(member) {
      var self = this;

      
      for (var i = 0, length = self.length; i < length; i++) {
        if ((self[i])['$=='](member)) {
          return true;
        }
      }

      return false;
    
    };

    def.$index = TMP_10 = function(object) {
      var self = this, $iter = TMP_10._p, block = $iter || nil;

      TMP_10._p = null;
      
      if (object != null) {
        for (var i = 0, length = self.length; i < length; i++) {
          if ((self[i])['$=='](object)) {
            return i;
          }
        }
      }
      else if (block !== nil) {
        for (var i = 0, length = self.length, value; i < length; i++) {
          if ((value = block(self[i])) === $breaker) {
            return $breaker.$v;
          }

          if (value !== false && value !== nil) {
            return i;
          }
        }
      }
      else {
        return self.$enum_for("index");
      }

      return nil;
    
    };

    def.$insert = function(index, objects) {
      var $a, self = this;

      objects = $slice.call(arguments, 1);
      
      index = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(index, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

      if (objects.length > 0) {
        if (index < 0) {
          index += self.length + 1;

          if (index < 0) {
            self.$raise((($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a), "" + (index) + " is out of bounds");
          }
        }
        if (index > self.length) {
          for (var i = self.length; i < index; i++) {
            self.push(nil);
          }
        }

        self.splice.apply(self, [index, 0].concat(objects));
      }
    ;
      return self;
    };

    def.$inspect = function() {
      var self = this;

      
      var i, inspect, el, el_insp, length, object_id;

      inspect = [];
      object_id = self.$object_id();
      length = self.length;

      for (i = 0; i < length; i++) {
        el = self['$[]'](i);

        // Check object_id to ensure it's not the same array get into an infinite loop
        el_insp = (el).$object_id() === object_id ? '[...]' : (el).$inspect();

        inspect.push(el_insp);
      }
      return '[' + inspect.join(', ') + ']';
    ;
    };

    def.$join = function(sep) {
      var $a, self = this;
      if ($gvars[","] == null) $gvars[","] = nil;

      if (sep == null) {
        sep = nil
      }
      if ((($a = self.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
        return ""};
      if ((($a = sep === nil) !== nil && (!$a._isBoolean || $a == true))) {
        sep = $gvars[","]};
      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if ((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$respond_to?'](item, "to_str")) {
          var tmp = (item).$to_str();

          if (tmp !== nil) {
            result.push((tmp).$to_s());

            continue;
          }
        }

        if ((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$respond_to?'](item, "to_ary")) {
          var tmp = (item).$to_ary();

          if (tmp !== nil) {
            result.push((tmp).$join(sep));

            continue;
          }
        }

        if ((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$respond_to?'](item, "to_s")) {
          var tmp = (item).$to_s();

          if (tmp !== nil) {
            result.push(tmp);

            continue;
          }
        }

        self.$raise((($a = $scope.NoMethodError) == null ? $opal.cm('NoMethodError') : $a), "" + ((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$inspect(item)) + " doesn't respond to #to_str, #to_ary or #to_s");
      }

      if (sep === nil) {
        return result.join('');
      }
      else {
        return result.join((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](sep, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s());
      }
    ;
    };

    def.$keep_if = TMP_11 = function() {
      var self = this, $iter = TMP_11._p, block = $iter || nil;

      TMP_11._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("keep_if")
      };
      
      for (var i = 0, length = self.length, value; i < length; i++) {
        if ((value = block(self[i])) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }
    
      return self;
    };

    def.$last = function(count) {
      var $a, self = this;

      
      if (count == null) {
        return self.length === 0 ? nil : self[self.length - 1];
      }

      count = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(count, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");

      if (count < 0) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "negative array size");
      }

      if (count > self.length) {
        count = self.length;
      }

      return self.slice(self.length - count, self.length);
    
    };

    def.$length = function() {
      var self = this;

      return self.length;
    };

    $opal.defn(self, '$map', def.$collect);

    $opal.defn(self, '$map!', def['$collect!']);

    def.$pop = function(count) {
      var $a, self = this;

      if ((($a = count === undefined) !== nil && (!$a._isBoolean || $a == true))) {
        if ((($a = self.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
          return nil};
        return self.pop();};
      count = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(count, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      if ((($a = count < 0) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "negative array size")};
      if ((($a = self.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
        return []};
      if ((($a = count > self.length) !== nil && (!$a._isBoolean || $a == true))) {
        return self.splice(0, self.length);
        } else {
        return self.splice(self.length - count, self.length);
      };
    };

    def.$push = function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      
      for (var i = 0, length = objects.length; i < length; i++) {
        self.push(objects[i]);
      }
    
      return self;
    };

    def.$rassoc = function(object) {
      var self = this;

      
      for (var i = 0, length = self.length, item; i < length; i++) {
        item = self[i];

        if (item.length && item[1] !== undefined) {
          if ((item[1])['$=='](object)) {
            return item;
          }
        }
      }

      return nil;
    
    };

    def.$reject = TMP_12 = function() {
      var self = this, $iter = TMP_12._p, block = $iter || nil;

      TMP_12._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reject")
      };
      
      var result = [];

      for (var i = 0, length = self.length, value; i < length; i++) {
        if ((value = block(self[i])) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          result.push(self[i]);
        }
      }
      return result;
    
    };

    def['$reject!'] = TMP_13 = function() {
      var $a, $b, self = this, $iter = TMP_13._p, block = $iter || nil, original = nil;

      TMP_13._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reject!")
      };
      original = self.$length();
      ($a = ($b = self).$delete_if, $a._p = block.$to_proc(), $a).call($b);
      if (self.$length()['$=='](original)) {
        return nil
        } else {
        return self
      };
    };

    def.$replace = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.Array) == null ? $opal.cm('Array') : $a), "to_ary").$to_a()
      };
      
      self.splice(0, self.length);
      self.push.apply(self, other);
    
      return self;
    };

    def.$reverse = function() {
      var self = this;

      return self.slice(0).reverse();
    };

    def['$reverse!'] = function() {
      var self = this;

      return self.reverse();
    };

    def.$reverse_each = TMP_14 = function() {
      var $a, $b, self = this, $iter = TMP_14._p, block = $iter || nil;

      TMP_14._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reverse_each")
      };
      ($a = ($b = self.$reverse()).$each, $a._p = block.$to_proc(), $a).call($b);
      return self;
    };

    def.$rindex = TMP_15 = function(object) {
      var self = this, $iter = TMP_15._p, block = $iter || nil;

      TMP_15._p = null;
      
      if (object != null) {
        for (var i = self.length - 1; i >= 0; i--) {
          if ((self[i])['$=='](object)) {
            return i;
          }
        }
      }
      else if (block !== nil) {
        for (var i = self.length - 1, value; i >= 0; i--) {
          if ((value = block(self[i])) === $breaker) {
            return $breaker.$v;
          }

          if (value !== false && value !== nil) {
            return i;
          }
        }
      }
      else if (object == null) {
        return self.$enum_for("rindex");
      }

      return nil;
    
    };

    def.$sample = function(n) {
      var $a, $b, TMP_16, self = this;

      if (n == null) {
        n = nil
      }
      if ((($a = ($b = n['$!'](), $b !== false && $b !== nil ?self['$empty?']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return nil};
      if ((($a = (($b = n !== false && n !== nil) ? self['$empty?']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return []};
      if (n !== false && n !== nil) {
        return ($a = ($b = ($range(1, n, false))).$map, $a._p = (TMP_16 = function(){var self = TMP_16._s || this;

        return self['$[]'](self.$rand(self.$length()))}, TMP_16._s = self, TMP_16), $a).call($b)
        } else {
        return self['$[]'](self.$rand(self.$length()))
      };
    };

    def.$select = TMP_17 = function() {
      var self = this, $iter = TMP_17._p, block = $iter || nil;

      TMP_17._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("select")
      };
      
      var result = [];

      for (var i = 0, length = self.length, item, value; i < length; i++) {
        item = self[i];

        if ((value = $opal.$yield1(block, item)) === $breaker) {
          return $breaker.$v;
        }

        if (value !== false && value !== nil) {
          result.push(item);
        }
      }

      return result;
    
    };

    def['$select!'] = TMP_18 = function() {
      var $a, $b, self = this, $iter = TMP_18._p, block = $iter || nil;

      TMP_18._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("select!")
      };
      
      var original = self.length;
      ($a = ($b = self).$keep_if, $a._p = block.$to_proc(), $a).call($b);
      return self.length === original ? nil : self;
    
    };

    def.$shift = function(count) {
      var $a, self = this;

      if ((($a = count === undefined) !== nil && (!$a._isBoolean || $a == true))) {
        if ((($a = self.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
          return nil};
        return self.shift();};
      count = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(count, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      if ((($a = count < 0) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "negative array size")};
      if ((($a = self.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
        return []};
      return self.splice(0, count);
    };

    $opal.defn(self, '$size', def.$length);

    def.$shuffle = function() {
      var self = this;

      return self.$clone()['$shuffle!']();
    };

    def['$shuffle!'] = function() {
      var self = this;

      
      for (var i = self.length - 1; i > 0; i--) {
        var tmp = self[i],
            j   = Math.floor(Math.random() * (i + 1));

        self[i] = self[j];
        self[j] = tmp;
      }
    
      return self;
    };

    $opal.defn(self, '$slice', def['$[]']);

    def['$slice!'] = function(index, length) {
      var self = this;

      
      if (index < 0) {
        index += self.length;
      }

      if (length != null) {
        return self.splice(index, length);
      }

      if (index < 0 || index >= self.length) {
        return nil;
      }

      return self.splice(index, 1)[0];
    
    };

    def.$sort = TMP_19 = function() {
      var $a, self = this, $iter = TMP_19._p, block = $iter || nil;

      TMP_19._p = null;
      if ((($a = self.length > 1) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return self
      };
      
      if (!(block !== nil)) {
        block = function(a, b) {
          return (a)['$<=>'](b);
        };
      }

      try {
        return self.slice().sort(function(x, y) {
          var ret = block(x, y);

          if (ret === $breaker) {
            throw $breaker;
          }
          else if (ret === nil) {
            self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison of " + ((x).$inspect()) + " with " + ((y).$inspect()) + " failed");
          }

          return (ret)['$>'](0) ? 1 : ((ret)['$<'](0) ? -1 : 0);
        });
      }
      catch (e) {
        if (e === $breaker) {
          return $breaker.$v;
        }
        else {
          throw e;
        }
      }
    ;
    };

    def['$sort!'] = TMP_20 = function() {
      var $a, $b, self = this, $iter = TMP_20._p, block = $iter || nil;

      TMP_20._p = null;
      
      var result;

      if ((block !== nil)) {
        result = ($a = ($b = (self.slice())).$sort, $a._p = block.$to_proc(), $a).call($b);
      }
      else {
        result = (self.slice()).$sort();
      }

      self.length = 0;
      for(var i = 0, length = result.length; i < length; i++) {
        self.push(result[i]);
      }

      return self;
    ;
    };

    def.$take = function(count) {
      var $a, self = this;

      
      if (count < 0) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a));
      }

      return self.slice(0, count);
    ;
    };

    def.$take_while = TMP_21 = function() {
      var self = this, $iter = TMP_21._p, block = $iter || nil;

      TMP_21._p = null;
      
      var result = [];

      for (var i = 0, length = self.length, item, value; i < length; i++) {
        item = self[i];

        if ((value = block(item)) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          return result;
        }

        result.push(item);
      }

      return result;
    
    };

    def.$to_a = function() {
      var self = this;

      return self;
    };

    $opal.defn(self, '$to_ary', def.$to_a);

    $opal.defn(self, '$to_s', def.$inspect);

    def.$transpose = function() {
      var $a, $b, TMP_22, self = this, result = nil, max = nil;

      if ((($a = self['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
        return []};
      result = [];
      max = nil;
      ($a = ($b = self).$each, $a._p = (TMP_22 = function(row){var self = TMP_22._s || this, $a, $b, TMP_23;
if (row == null) row = nil;
      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](row)) !== nil && (!$a._isBoolean || $a == true))) {
          row = row.$to_a()
          } else {
          row = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(row, (($a = $scope.Array) == null ? $opal.cm('Array') : $a), "to_ary").$to_a()
        };
        ((($a = max) !== false && $a !== nil) ? $a : max = row.length);
        if ((($a = (row.length)['$=='](max)['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
          self.$raise((($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a), "element size differs (" + (row.length) + " should be " + (max))};
        return ($a = ($b = (row.length)).$times, $a._p = (TMP_23 = function(i){var self = TMP_23._s || this, $a, $b, $c, entry = nil;
if (i == null) i = nil;
        entry = (($a = i, $b = result, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, []))));
          return entry['$<<'](row.$at(i));}, TMP_23._s = self, TMP_23), $a).call($b);}, TMP_22._s = self, TMP_22), $a).call($b);
      return result;
    };

    def.$uniq = function() {
      var self = this;

      
      var result = [],
          seen   = {};

      for (var i = 0, length = self.length, item, hash; i < length; i++) {
        item = self[i];
        hash = item;

        if (!seen[hash]) {
          seen[hash] = true;

          result.push(item);
        }
      }

      return result;
    
    };

    def['$uniq!'] = function() {
      var self = this;

      
      var original = self.length,
          seen     = {};

      for (var i = 0, length = original, item, hash; i < length; i++) {
        item = self[i];
        hash = item;

        if (!seen[hash]) {
          seen[hash] = true;
        }
        else {
          self.splice(i, 1);

          length--;
          i--;
        }
      }

      return self.length === original ? nil : self;
    
    };

    def.$unshift = function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      
      for (var i = objects.length - 1; i >= 0; i--) {
        self.unshift(objects[i]);
      }
    
      return self;
    };

    return (def.$zip = TMP_24 = function(others) {
      var self = this, $iter = TMP_24._p, block = $iter || nil;

      others = $slice.call(arguments, 0);
      TMP_24._p = null;
      
      var result = [], size = self.length, part, o;

      for (var i = 0; i < size; i++) {
        part = [self[i]];

        for (var j = 0, jj = others.length; j < jj; j++) {
          o = others[j][i];

          if (o == null) {
            o = nil;
          }

          part[j + 1] = o;
        }

        result[i] = part;
      }

      if (block !== nil) {
        for (var i = 0; i < size; i++) {
          block(result[i]);
        }

        return nil;
      }

      return result;
    
    }, nil) && 'zip';
  })(self, null);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$new', '$allocate', '$initialize', '$to_proc', '$__send__', '$clone', '$respond_to?', '$==', '$eql?', '$inspect', '$*', '$class', '$slice', '$uniq', '$flatten']);
  (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self._proto, $scope = self._scope;

    return ($opal.defs(self, '$inherited', function(klass) {
      var $a, $b, self = this, replace = nil;

      replace = (($a = $scope.Class) == null ? $opal.cm('Class') : $a).$new((($a = ((($b = $scope.Array) == null ? $opal.cm('Array') : $b))._scope).Wrapper == null ? $a.cm('Wrapper') : $a.Wrapper));
      
      klass._proto        = replace._proto;
      klass._proto._klass = klass;
      klass._alloc        = replace._alloc;
      klass.__parent      = (($a = ((($b = $scope.Array) == null ? $opal.cm('Array') : $b))._scope).Wrapper == null ? $a.cm('Wrapper') : $a.Wrapper);

      klass.$allocate = replace.$allocate;
      klass.$new      = replace.$new;
      klass["$[]"]    = replace["$[]"];
    
    }), nil) && 'inherited'
  })(self, null);
  return (function($base, $super) {
    function $Wrapper(){};
    var self = $Wrapper = $klass($base, $super, 'Wrapper', $Wrapper);

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5;

    def.literal = nil;
    $opal.defs(self, '$allocate', TMP_1 = function(array) {
      var self = this, $iter = TMP_1._p, $yield = $iter || nil, obj = nil;

      if (array == null) {
        array = []
      }
      TMP_1._p = null;
      obj = $opal.find_super_dispatcher(self, 'allocate', TMP_1, null, $Wrapper).apply(self, []);
      obj.literal = array;
      return obj;
    });

    $opal.defs(self, '$new', TMP_2 = function(args) {
      var $a, $b, self = this, $iter = TMP_2._p, block = $iter || nil, obj = nil;

      args = $slice.call(arguments, 0);
      TMP_2._p = null;
      obj = self.$allocate();
      ($a = ($b = obj).$initialize, $a._p = block.$to_proc(), $a).apply($b, [].concat(args));
      return obj;
    });

    $opal.defs(self, '$[]', function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      return self.$allocate(objects);
    });

    def.$initialize = TMP_3 = function(args) {
      var $a, $b, $c, self = this, $iter = TMP_3._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_3._p = null;
      return self.literal = ($a = ($b = (($c = $scope.Array) == null ? $opal.cm('Array') : $c)).$new, $a._p = block.$to_proc(), $a).apply($b, [].concat(args));
    };

    def.$method_missing = TMP_4 = function(args) {
      var $a, $b, self = this, $iter = TMP_4._p, block = $iter || nil, result = nil;

      args = $slice.call(arguments, 0);
      TMP_4._p = null;
      result = ($a = ($b = self.literal).$__send__, $a._p = block.$to_proc(), $a).apply($b, [].concat(args));
      if ((($a = result === self.literal) !== nil && (!$a._isBoolean || $a == true))) {
        return self
        } else {
        return result
      };
    };

    def.$initialize_copy = function(other) {
      var self = this;

      return self.literal = (other.literal).$clone();
    };

    def['$respond_to?'] = TMP_5 = function(name) {var $zuper = $slice.call(arguments, 0);
      var $a, self = this, $iter = TMP_5._p, $yield = $iter || nil;

      TMP_5._p = null;
      return ((($a = $opal.find_super_dispatcher(self, 'respond_to?', TMP_5, $iter).apply(self, $zuper)) !== false && $a !== nil) ? $a : self.literal['$respond_to?'](name));
    };

    def['$=='] = function(other) {
      var self = this;

      return self.literal['$=='](other);
    };

    def['$eql?'] = function(other) {
      var self = this;

      return self.literal['$eql?'](other);
    };

    def.$to_a = function() {
      var self = this;

      return self.literal;
    };

    def.$to_ary = function() {
      var self = this;

      return self;
    };

    def.$inspect = function() {
      var self = this;

      return self.literal.$inspect();
    };

    def['$*'] = function(other) {
      var self = this;

      
      var result = self.literal['$*'](other);

      if (result._isArray) {
        return self.$class().$allocate(result)
      }
      else {
        return result;
      }
    ;
    };

    def['$[]'] = function(index, length) {
      var self = this;

      
      var result = self.literal.$slice(index, length);

      if (result._isArray && (index._isRange || length !== undefined)) {
        return self.$class().$allocate(result)
      }
      else {
        return result;
      }
    ;
    };

    $opal.defn(self, '$slice', def['$[]']);

    def.$uniq = function() {
      var self = this;

      return self.$class().$allocate(self.literal.$uniq());
    };

    return (def.$flatten = function(level) {
      var self = this;

      return self.$class().$allocate(self.literal.$flatten(level));
    }, nil) && 'flatten';
  })((($a = $scope.Array) == null ? $opal.cm('Array') : $a), null);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$!', '$==', '$call', '$coerce_to!', '$lambda?', '$abs', '$arity', '$raise', '$enum_for', '$flatten', '$inspect', '$===', '$alias_method', '$clone']);
  ;
  return (function($base, $super) {
    function $Hash(){};
    var self = $Hash = $klass($base, $super, 'Hash', $Hash);

    var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13;

    def.proc = def.none = nil;
    self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

    $opal.defs(self, '$[]', function(objs) {
      var self = this;

      objs = $slice.call(arguments, 0);
      return $opal.hash.apply(null, objs);
    });

    $opal.defs(self, '$allocate', function() {
      var self = this;

      
      var hash = new self._alloc;

      hash.map  = {};
      hash.keys = [];
      hash.none = nil;
      hash.proc = nil;

      return hash;
    
    });

    def.$initialize = TMP_1 = function(defaults) {
      var self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      
      self.none = (defaults === undefined ? nil : defaults);
      self.proc = block;
    
      return self;
    };

    def['$=='] = function(other) {
      var self = this;

      
      if (self === other) {
        return true;
      }

      if (!other.map || !other.keys) {
        return false;
      }

      if (self.keys.length !== other.keys.length) {
        return false;
      }

      var map  = self.map,
          map2 = other.map;

      for (var i = 0, length = self.keys.length; i < length; i++) {
        var key = self.keys[i], obj = map[key], obj2 = map2[key];
        if (obj2 === undefined || (obj)['$=='](obj2)['$!']()) {
          return false;
        }
      }

      return true;
    
    };

    def['$[]'] = function(key) {
      var self = this;

      
      var map = self.map;

      if ($opal.hasOwnProperty.call(map, key)) {
        return map[key];
      }

      var proc = self.proc;

      if (proc !== nil) {
        return (proc).$call(self, key);
      }

      return self.none;
    
    };

    def['$[]='] = function(key, value) {
      var self = this;

      
      var map = self.map;

      if (!$opal.hasOwnProperty.call(map, key)) {
        self.keys.push(key);
      }

      map[key] = value;

      return value;
    
    };

    def.$assoc = function(object) {
      var self = this;

      
      var keys = self.keys, key;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if ((key)['$=='](object)) {
          return [key, self.map[key]];
        }
      }

      return nil;
    
    };

    def.$clear = function() {
      var self = this;

      
      self.map = {};
      self.keys = [];
      return self;
    
    };

    def.$clone = function() {
      var self = this;

      
      var map  = {},
          keys = [];

      for (var i = 0, length = self.keys.length; i < length; i++) {
        var key   = self.keys[i],
            value = self.map[key];

        keys.push(key);
        map[key] = value;
      }

      var hash = new self._klass._alloc();

      hash.map  = map;
      hash.keys = keys;
      hash.none = self.none;
      hash.proc = self.proc;

      return hash;
    
    };

    def.$default = function(val) {
      var self = this;

      
      if (val !== undefined && self.proc !== nil) {
        return self.proc.$call(self, val);
      }
      return self.none;
    ;
    };

    def['$default='] = function(object) {
      var self = this;

      
      self.proc = nil;
      return (self.none = object);
    
    };

    def.$default_proc = function() {
      var self = this;

      return self.proc;
    };

    def['$default_proc='] = function(proc) {
      var $a, self = this;

      
      if (proc !== nil) {
        proc = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](proc, (($a = $scope.Proc) == null ? $opal.cm('Proc') : $a), "to_proc");

        if (proc['$lambda?']() && proc.$arity().$abs() != 2) {
          self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "default_proc takes two arguments");
        }
      }
      self.none = nil;
      return (self.proc = proc);
    ;
    };

    def.$delete = TMP_2 = function(key) {
      var self = this, $iter = TMP_2._p, block = $iter || nil;

      TMP_2._p = null;
      
      var map  = self.map, result = map[key];

      if (result != null) {
        delete map[key];
        self.keys.$delete(key);

        return result;
      }

      if (block !== nil) {
        return block.$call(key);
      }
      return nil;
    
    };

    def.$delete_if = TMP_3 = function() {
      var self = this, $iter = TMP_3._p, block = $iter || nil;

      TMP_3._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("delete_if")
      };
      
      var map = self.map, keys = self.keys, value;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], obj = map[key];

        if ((value = block(key, obj)) === $breaker) {
          return $breaker.$v;
        }

        if (value !== false && value !== nil) {
          keys.splice(i, 1);
          delete map[key];

          length--;
          i--;
        }
      }

      return self;
    
    };

    $opal.defn(self, '$dup', def.$clone);

    def.$each = TMP_4 = function() {
      var self = this, $iter = TMP_4._p, block = $iter || nil;

      TMP_4._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each")
      };
      
      var map  = self.map,
          keys = self.keys;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key   = keys[i],
            value = $opal.$yield1(block, [key, map[key]]);

        if (value === $breaker) {
          return $breaker.$v;
        }
      }

      return self;
    
    };

    def.$each_key = TMP_5 = function() {
      var self = this, $iter = TMP_5._p, block = $iter || nil;

      TMP_5._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each_key")
      };
      
      var keys = self.keys;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i];

        if (block(key) === $breaker) {
          return $breaker.$v;
        }
      }

      return self;
    
    };

    $opal.defn(self, '$each_pair', def.$each);

    def.$each_value = TMP_6 = function() {
      var self = this, $iter = TMP_6._p, block = $iter || nil;

      TMP_6._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each_value")
      };
      
      var map = self.map, keys = self.keys;

      for (var i = 0, length = keys.length; i < length; i++) {
        if (block(map[keys[i]]) === $breaker) {
          return $breaker.$v;
        }
      }

      return self;
    
    };

    def['$empty?'] = function() {
      var self = this;

      return self.keys.length === 0;
    };

    $opal.defn(self, '$eql?', def['$==']);

    def.$fetch = TMP_7 = function(key, defaults) {
      var $a, self = this, $iter = TMP_7._p, block = $iter || nil;

      TMP_7._p = null;
      
      var value = self.map[key];

      if (value != null) {
        return value;
      }

      if (block !== nil) {
        var value;

        if ((value = block(key)) === $breaker) {
          return $breaker.$v;
        }

        return value;
      }

      if (defaults != null) {
        return defaults;
      }

      self.$raise((($a = $scope.KeyError) == null ? $opal.cm('KeyError') : $a), "key not found");
    
    };

    def.$flatten = function(level) {
      var self = this;

      
      var map = self.map, keys = self.keys, result = [];

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], value = map[key];

        result.push(key);

        if (value._isArray) {
          if (level == null || level === 1) {
            result.push(value);
          }
          else {
            result = result.concat((value).$flatten(level - 1));
          }
        }
        else {
          result.push(value);
        }
      }

      return result;
    
    };

    def['$has_key?'] = function(key) {
      var self = this;

      return $opal.hasOwnProperty.call(self.map, key);
    };

    def['$has_value?'] = function(value) {
      var self = this;

      
      for (var assoc in self.map) {
        if ((self.map[assoc])['$=='](value)) {
          return true;
        }
      }

      return false;
    ;
    };

    def.$hash = function() {
      var self = this;

      return self._id;
    };

    $opal.defn(self, '$include?', def['$has_key?']);

    def.$index = function(object) {
      var self = this;

      
      var map = self.map, keys = self.keys;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i];

        if ((map[key])['$=='](object)) {
          return key;
        }
      }

      return nil;
    
    };

    def.$indexes = function(keys) {
      var self = this;

      keys = $slice.call(arguments, 0);
      
      var result = [], map = self.map, val;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], val = map[key];

        if (val != null) {
          result.push(val);
        }
        else {
          result.push(self.none);
        }
      }

      return result;
    
    };

    $opal.defn(self, '$indices', def.$indexes);

    def.$inspect = function() {
      var self = this;

      
      var inspect = [], keys = self.keys, map = self.map;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], val = map[key];

        if (val === self) {
          inspect.push((key).$inspect() + '=>' + '{...}');
        } else {
          inspect.push((key).$inspect() + '=>' + (map[key]).$inspect());
        }
      }

      return '{' + inspect.join(', ') + '}';
    ;
    };

    def.$invert = function() {
      var self = this;

      
      var result = $opal.hash(), keys = self.keys, map = self.map,
          keys2 = result.keys, map2 = result.map;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], obj = map[key];

        keys2.push(obj);
        map2[obj] = key;
      }

      return result;
    
    };

    def.$keep_if = TMP_8 = function() {
      var self = this, $iter = TMP_8._p, block = $iter || nil;

      TMP_8._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("keep_if")
      };
      
      var map = self.map, keys = self.keys, value;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], obj = map[key];

        if ((value = block(key, obj)) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          keys.splice(i, 1);
          delete map[key];

          length--;
          i--;
        }
      }

      return self;
    
    };

    $opal.defn(self, '$key', def.$index);

    $opal.defn(self, '$key?', def['$has_key?']);

    def.$keys = function() {
      var self = this;

      return self.keys.slice(0);
    };

    def.$length = function() {
      var self = this;

      return self.keys.length;
    };

    $opal.defn(self, '$member?', def['$has_key?']);

    def.$merge = TMP_9 = function(other) {
      var $a, self = this, $iter = TMP_9._p, block = $iter || nil;

      TMP_9._p = null;
      
      if (! (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a)['$==='](other)) {
        other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](other, (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a), "to_hash");
      }

      var keys = self.keys, map = self.map,
          result = $opal.hash(), keys2 = result.keys, map2 = result.map;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i];

        keys2.push(key);
        map2[key] = map[key];
      }

      var keys = other.keys, map = other.map;

      if (block === nil) {
        for (var i = 0, length = keys.length; i < length; i++) {
          var key = keys[i];

          if (map2[key] == null) {
            keys2.push(key);
          }

          map2[key] = map[key];
        }
      }
      else {
        for (var i = 0, length = keys.length; i < length; i++) {
          var key = keys[i];

          if (map2[key] == null) {
            keys2.push(key);
            map2[key] = map[key];
          }
          else {
            map2[key] = block(key, map2[key], map[key]);
          }
        }
      }

      return result;
    ;
    };

    def['$merge!'] = TMP_10 = function(other) {
      var $a, self = this, $iter = TMP_10._p, block = $iter || nil;

      TMP_10._p = null;
      
      if (! (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a)['$==='](other)) {
        other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](other, (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a), "to_hash");
      }

      var keys = self.keys, map = self.map,
          keys2 = other.keys, map2 = other.map;

      if (block === nil) {
        for (var i = 0, length = keys2.length; i < length; i++) {
          var key = keys2[i];

          if (map[key] == null) {
            keys.push(key);
          }

          map[key] = map2[key];
        }
      }
      else {
        for (var i = 0, length = keys2.length; i < length; i++) {
          var key = keys2[i];

          if (map[key] == null) {
            keys.push(key);
            map[key] = map2[key];
          }
          else {
            map[key] = block(key, map[key], map2[key]);
          }
        }
      }

      return self;
    ;
    };

    def.$rassoc = function(object) {
      var self = this;

      
      var keys = self.keys, map = self.map;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], obj = map[key];

        if ((obj)['$=='](object)) {
          return [key, obj];
        }
      }

      return nil;
    
    };

    def.$reject = TMP_11 = function() {
      var self = this, $iter = TMP_11._p, block = $iter || nil;

      TMP_11._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("reject")
      };
      
      var keys = self.keys, map = self.map,
          result = $opal.hash(), map2 = result.map, keys2 = result.keys;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], obj = map[key], value;

        if ((value = block(key, obj)) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          keys2.push(key);
          map2[key] = obj;
        }
      }

      return result;
    
    };

    def.$replace = function(other) {
      var self = this;

      
      var map = self.map = {}, keys = self.keys = [];

      for (var i = 0, length = other.keys.length; i < length; i++) {
        var key = other.keys[i];
        keys.push(key);
        map[key] = other.map[key];
      }

      return self;
    
    };

    def.$select = TMP_12 = function() {
      var self = this, $iter = TMP_12._p, block = $iter || nil;

      TMP_12._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("select")
      };
      
      var keys = self.keys, map = self.map,
          result = $opal.hash(), map2 = result.map, keys2 = result.keys;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], obj = map[key], value;

        if ((value = block(key, obj)) === $breaker) {
          return $breaker.$v;
        }

        if (value !== false && value !== nil) {
          keys2.push(key);
          map2[key] = obj;
        }
      }

      return result;
    
    };

    def['$select!'] = TMP_13 = function() {
      var self = this, $iter = TMP_13._p, block = $iter || nil;

      TMP_13._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("select!")
      };
      
      var map = self.map, keys = self.keys, value, result = nil;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i], obj = map[key];

        if ((value = block(key, obj)) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          keys.splice(i, 1);
          delete map[key];

          length--;
          i--;
          result = self
        }
      }

      return result;
    
    };

    def.$shift = function() {
      var self = this;

      
      var keys = self.keys, map = self.map;

      if (keys.length) {
        var key = keys[0], obj = map[key];

        delete map[key];
        keys.splice(0, 1);

        return [key, obj];
      }

      return nil;
    
    };

    $opal.defn(self, '$size', def.$length);

    self.$alias_method("store", "[]=");

    def.$to_a = function() {
      var self = this;

      
      var keys = self.keys, map = self.map, result = [];

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i];
        result.push([key, map[key]]);
      }

      return result;
    
    };

    def.$to_h = function() {
      var self = this;

      
      var hash   = new Opal.Hash._alloc,
          cloned = self.$clone();

      hash.map  = cloned.map;
      hash.keys = cloned.keys;
      hash.none = cloned.none;
      hash.proc = cloned.proc;

      return hash;
    ;
    };

    def.$to_hash = function() {
      var self = this;

      return self;
    };

    $opal.defn(self, '$to_s', def.$inspect);

    $opal.defn(self, '$update', def['$merge!']);

    $opal.defn(self, '$value?', def['$has_value?']);

    $opal.defn(self, '$values_at', def.$indexes);

    return (def.$values = function() {
      var self = this;

      
      var map    = self.map,
          result = [];

      for (var key in map) {
        result.push(map[key]);
      }

      return result;
    
    }, nil) && 'values';
  })(self, null);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$include', '$to_str', '$===', '$format', '$coerce_to', '$to_s', '$respond_to?', '$<=>', '$raise', '$=~', '$empty?', '$ljust', '$ceil', '$/', '$+', '$rjust', '$floor', '$to_a', '$each_char', '$to_proc', '$coerce_to!', '$initialize_clone', '$initialize_dup', '$enum_for', '$split', '$chomp', '$escape', '$class', '$to_i', '$name', '$!', '$each_line', '$match', '$new', '$try_convert', '$chars', '$&', '$join', '$is_a?', '$[]', '$str', '$value', '$proc', '$send']);
  ;
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7;

    def.length = nil;
    self.$include((($a = $scope.Comparable) == null ? $opal.cm('Comparable') : $a));

    def._isString = true;

    $opal.defs(self, '$try_convert', function(what) {
      var self = this;

      try {
      return what.$to_str()
      } catch ($err) {if (true) {
        return nil
        }else { throw $err; }
      };
    });

    $opal.defs(self, '$new', function(str) {
      var self = this;

      if (str == null) {
        str = ""
      }
      return new String(str);
    });

    def['$%'] = function(data) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Array) == null ? $opal.cm('Array') : $b)['$==='](data)) !== nil && (!$a._isBoolean || $a == true))) {
        return ($a = self).$format.apply($a, [self].concat(data))
        } else {
        return self.$format(self, data)
      };
    };

    def['$*'] = function(count) {
      var self = this;

      
      if (count < 1) {
        return '';
      }

      var result  = '',
          pattern = self;

      while (count > 0) {
        if (count & 1) {
          result += pattern;
        }

        count >>= 1;
        pattern += pattern;
      }

      return result;
    
    };

    def['$+'] = function(other) {
      var $a, self = this;

      other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str");
      return self + other.$to_s();
    };

    def['$<=>'] = function(other) {
      var $a, self = this;

      if ((($a = other['$respond_to?']("to_str")) !== nil && (!$a._isBoolean || $a == true))) {
        other = other.$to_str().$to_s();
        return self > other ? 1 : (self < other ? -1 : 0);
        } else {
        
        var cmp = other['$<=>'](self);

        if (cmp === nil) {
          return nil;
        }
        else {
          return cmp > 0 ? -1 : (cmp < 0 ? 1 : 0);
        }
      ;
      };
    };

    def['$=='] = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.String) == null ? $opal.cm('String') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      return self.$to_s() == other.$to_s();
    };

    $opal.defn(self, '$eql?', def['$==']);

    $opal.defn(self, '$===', def['$==']);

    def['$=~'] = function(other) {
      var $a, self = this;

      
      if (other._isString) {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "type mismatch: String given");
      }

      return other['$=~'](self);
    ;
    };

    def['$[]'] = function(index, length) {
      var self = this;

      
      var size = self.length;

      if (index._isRange) {
        var exclude = index.exclude,
            length  = index.end,
            index   = index.begin;

        if (index < 0) {
          index += size;
        }

        if (length < 0) {
          length += size;
        }

        if (!exclude) {
          length += 1;
        }

        if (index > size) {
          return nil;
        }

        length = length - index;

        if (length < 0) {
          length = 0;
        }

        return self.substr(index, length);
      }

      if (index < 0) {
        index += self.length;
      }

      if (length == null) {
        if (index >= self.length || index < 0) {
          return nil;
        }

        return self.substr(index, 1);
      }

      if (index > self.length || index < 0) {
        return nil;
      }

      return self.substr(index, length);
    
    };

    def.$capitalize = function() {
      var self = this;

      return self.charAt(0).toUpperCase() + self.substr(1).toLowerCase();
    };

    def.$casecmp = function(other) {
      var $a, self = this;

      other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();
      return (self.toLowerCase())['$<=>'](other.toLowerCase());
    };

    def.$center = function(width, padstr) {
      var $a, self = this;

      if (padstr == null) {
        padstr = " "
      }
      width = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(width, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      padstr = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(padstr, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();
      if ((($a = padstr['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "zero width padding")};
      if ((($a = width <= self.length) !== nil && (!$a._isBoolean || $a == true))) {
        return self};
      
      var ljustified = self.$ljust((width['$+'](self.length))['$/'](2).$ceil(), padstr),
          rjustified = self.$rjust((width['$+'](self.length))['$/'](2).$floor(), padstr);

      return rjustified + ljustified.slice(self.length);
    ;
    };

    def.$chars = TMP_1 = function() {
      var $a, $b, self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$each_char().$to_a()
      };
      return ($a = ($b = self).$each_char, $a._p = block.$to_proc(), $a).call($b);
    };

    def.$chomp = function(separator) {
      var $a, self = this;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"]
      }
      if ((($a = separator === nil || self.length === 0) !== nil && (!$a._isBoolean || $a == true))) {
        return self};
      separator = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](separator, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();
      
      if (separator === "\n") {
        return self.replace(/\r?\n?$/, '');
      }
      else if (separator === "") {
        return self.replace(/(\r?\n)+$/, '');
      }
      else if (self.length > separator.length) {
        var tail = self.substr(self.length - separator.length, separator.length);

        if (tail === separator) {
          return self.substr(0, self.length - separator.length);
        }
      }
    
      return self;
    };

    def.$chop = function() {
      var self = this;

      
      var length = self.length;

      if (length <= 1) {
        return "";
      }

      if (self.charAt(length - 1) === "\n" && self.charAt(length - 2) === "\r") {
        return self.substr(0, length - 2);
      }
      else {
        return self.substr(0, length - 1);
      }
    
    };

    def.$chr = function() {
      var self = this;

      return self.charAt(0);
    };

    def.$clone = function() {
      var self = this, copy = nil;

      copy = self.slice();
      copy.$initialize_clone(self);
      return copy;
    };

    def.$dup = function() {
      var self = this, copy = nil;

      copy = self.slice();
      copy.$initialize_dup(self);
      return copy;
    };

    def.$count = function(str) {
      var self = this;

      return (self.length - self.replace(new RegExp(str, 'g'), '').length) / str.length;
    };

    $opal.defn(self, '$dup', def.$clone);

    def.$downcase = function() {
      var self = this;

      return self.toLowerCase();
    };

    def.$each_char = TMP_2 = function() {
      var $a, self = this, $iter = TMP_2._p, block = $iter || nil;

      TMP_2._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_char")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        ((($a = $opal.$yield1(block, self.charAt(i))) === $breaker) ? $breaker.$v : $a);
      }
    
      return self;
    };

    def.$each_line = TMP_3 = function(separator) {
      var $a, self = this, $iter = TMP_3._p, $yield = $iter || nil;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"]
      }
      TMP_3._p = null;
      if (($yield !== nil)) {
        } else {
        return self.$split(separator)
      };
      
      var chomped  = self.$chomp(),
          trailing = self.length != chomped.length,
          splitted = chomped.split(separator);

      for (var i = 0, length = splitted.length; i < length; i++) {
        if (i < length - 1 || trailing) {
          ((($a = $opal.$yield1($yield, splitted[i] + separator)) === $breaker) ? $breaker.$v : $a);
        }
        else {
          ((($a = $opal.$yield1($yield, splitted[i])) === $breaker) ? $breaker.$v : $a);
        }
      }
    ;
      return self;
    };

    def['$empty?'] = function() {
      var self = this;

      return self.length === 0;
    };

    def['$end_with?'] = function(suffixes) {
      var $a, self = this;

      suffixes = $slice.call(arguments, 0);
      
      for (var i = 0, length = suffixes.length; i < length; i++) {
        var suffix = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(suffixes[i], (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();

        if (self.length >= suffix.length &&
            self.substr(self.length - suffix.length, suffix.length) == suffix) {
          return true;
        }
      }
    
      return false;
    };

    $opal.defn(self, '$eql?', def['$==']);

    $opal.defn(self, '$equal?', def['$===']);

    def.$gsub = TMP_4 = function(pattern, replace) {
      var $a, $b, $c, self = this, $iter = TMP_4._p, block = $iter || nil;

      TMP_4._p = null;
      if ((($a = ((($b = (($c = $scope.String) == null ? $opal.cm('String') : $c)['$==='](pattern)) !== false && $b !== nil) ? $b : pattern['$respond_to?']("to_str"))) !== nil && (!$a._isBoolean || $a == true))) {
        pattern = (new RegExp("" + (($a = $scope.Regexp) == null ? $opal.cm('Regexp') : $a).$escape(pattern.$to_str())))};
      if ((($a = (($b = $scope.Regexp) == null ? $opal.cm('Regexp') : $b)['$==='](pattern)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "wrong argument type " + (pattern.$class()) + " (expected Regexp)")
      };
      
      var pattern = pattern.toString(),
          options = pattern.substr(pattern.lastIndexOf('/') + 1) + 'g',
          regexp  = pattern.substr(1, pattern.lastIndexOf('/') - 1);

      self.$sub._p = block;
      return self.$sub(new RegExp(regexp, options), replace);
    
    };

    def.$hash = function() {
      var self = this;

      return self.toString();
    };

    def.$hex = function() {
      var self = this;

      return self.$to_i(16);
    };

    def['$include?'] = function(other) {
      var $a, self = this;

      
      if (other._isString) {
        return self.indexOf(other) !== -1;
      }
    
      if ((($a = other['$respond_to?']("to_str")) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "no implicit conversion of " + (other.$class().$name()) + " into String")
      };
      return self.indexOf(other.$to_str()) !== -1;
    };

    def.$index = function(what, offset) {
      var $a, $b, self = this, result = nil;

      if (offset == null) {
        offset = nil
      }
      if ((($a = (($b = $scope.String) == null ? $opal.cm('String') : $b)['$==='](what)) !== nil && (!$a._isBoolean || $a == true))) {
        what = what.$to_s()
      } else if ((($a = what['$respond_to?']("to_str")) !== nil && (!$a._isBoolean || $a == true))) {
        what = what.$to_str().$to_s()
      } else if ((($a = (($b = $scope.Regexp) == null ? $opal.cm('Regexp') : $b)['$==='](what)['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "type mismatch: " + (what.$class()) + " given")};
      result = -1;
      if (offset !== false && offset !== nil) {
        offset = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(offset, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        
        var size = self.length;

        if (offset < 0) {
          offset = offset + size;
        }

        if (offset > size) {
          return nil;
        }
      
        if ((($a = (($b = $scope.Regexp) == null ? $opal.cm('Regexp') : $b)['$==='](what)) !== nil && (!$a._isBoolean || $a == true))) {
          result = ((($a = (what['$=~'](self.substr(offset)))) !== false && $a !== nil) ? $a : -1)
          } else {
          result = self.substr(offset).indexOf(what)
        };
        
        if (result !== -1) {
          result += offset;
        }
      
      } else if ((($a = (($b = $scope.Regexp) == null ? $opal.cm('Regexp') : $b)['$==='](what)) !== nil && (!$a._isBoolean || $a == true))) {
        result = ((($a = (what['$=~'](self))) !== false && $a !== nil) ? $a : -1)
        } else {
        result = self.indexOf(what)
      };
      if ((($a = result === -1) !== nil && (!$a._isBoolean || $a == true))) {
        return nil
        } else {
        return result
      };
    };

    def.$inspect = function() {
      var self = this;

      
      var escapable = /[\\\"\x00-\x1f\x7f-\x9f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
          meta      = {
            '\b': '\\b',
            '\t': '\\t',
            '\n': '\\n',
            '\f': '\\f',
            '\r': '\\r',
            '"' : '\\"',
            '\\': '\\\\'
          };

      escapable.lastIndex = 0;

      return escapable.test(self) ? '"' + self.replace(escapable, function(a) {
        var c = meta[a];

        return typeof c === 'string' ? c :
          '\\u' + ('0000' + a.charCodeAt(0).toString(16)).slice(-4);
      }) + '"' : '"' + self + '"';
    
    };

    def.$intern = function() {
      var self = this;

      return self;
    };

    def.$lines = function(separator) {
      var self = this;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"]
      }
      return self.$each_line(separator).$to_a();
    };

    def.$length = function() {
      var self = this;

      return self.length;
    };

    def.$ljust = function(width, padstr) {
      var $a, self = this;

      if (padstr == null) {
        padstr = " "
      }
      width = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(width, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      padstr = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(padstr, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();
      if ((($a = padstr['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "zero width padding")};
      if ((($a = width <= self.length) !== nil && (!$a._isBoolean || $a == true))) {
        return self};
      
      var index  = -1,
          result = "";

      width -= self.length;

      while (++index < width) {
        result += padstr;
      }

      return self + result.slice(0, width);
    
    };

    def.$lstrip = function() {
      var self = this;

      return self.replace(/^\s*/, '');
    };

    def.$match = TMP_5 = function(pattern, pos) {
      var $a, $b, $c, self = this, $iter = TMP_5._p, block = $iter || nil;

      TMP_5._p = null;
      if ((($a = ((($b = (($c = $scope.String) == null ? $opal.cm('String') : $c)['$==='](pattern)) !== false && $b !== nil) ? $b : pattern['$respond_to?']("to_str"))) !== nil && (!$a._isBoolean || $a == true))) {
        pattern = (new RegExp("" + (($a = $scope.Regexp) == null ? $opal.cm('Regexp') : $a).$escape(pattern.$to_str())))};
      if ((($a = (($b = $scope.Regexp) == null ? $opal.cm('Regexp') : $b)['$==='](pattern)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "wrong argument type " + (pattern.$class()) + " (expected Regexp)")
      };
      return ($a = ($b = pattern).$match, $a._p = block.$to_proc(), $a).call($b, self, pos);
    };

    def.$next = function() {
      var self = this;

      
      if (self.length === 0) {
        return "";
      }

      var initial = self.substr(0, self.length - 1);
      var last    = String.fromCharCode(self.charCodeAt(self.length - 1) + 1);

      return initial + last;
    
    };

    def.$ord = function() {
      var self = this;

      return self.charCodeAt(0);
    };

    def.$partition = function(str) {
      var self = this;

      
      var result = self.split(str);
      var splitter = (result[0].length === self.length ? "" : str);

      return [result[0], splitter, result.slice(1).join(str.toString())];
    
    };

    def.$reverse = function() {
      var self = this;

      return self.split('').reverse().join('');
    };

    def.$rindex = function(search, offset) {
      var $a, self = this;

      
      var search_type = (search == null ? Opal.NilClass : search.constructor);
      if (search_type != String && search_type != RegExp) {
        var msg = "type mismatch: " + search_type + " given";
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a).$new(msg));
      }

      if (self.length == 0) {
        return search.length == 0 ? 0 : nil;
      }

      var result = -1;
      if (offset != null) {
        if (offset < 0) {
          offset = self.length + offset;
        }

        if (search_type == String) {
          result = self.lastIndexOf(search, offset);
        }
        else {
          result = self.substr(0, offset + 1).$reverse().search(search);
          if (result !== -1) {
            result = offset - result;
          }
        }
      }
      else {
        if (search_type == String) {
          result = self.lastIndexOf(search);
        }
        else {
          result = self.$reverse().search(search);
          if (result !== -1) {
            result = self.length - 1 - result;
          }
        }
      }

      return result === -1 ? nil : result;
    
    };

    def.$rjust = function(width, padstr) {
      var $a, self = this;

      if (padstr == null) {
        padstr = " "
      }
      width = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(width, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      padstr = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(padstr, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();
      if ((($a = padstr['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "zero width padding")};
      if ((($a = width <= self.length) !== nil && (!$a._isBoolean || $a == true))) {
        return self};
      
      var chars     = Math.floor(width - self.length),
          patterns  = Math.floor(chars / padstr.length),
          result    = Array(patterns + 1).join(padstr),
          remaining = chars - result.length;

      return result + padstr.slice(0, remaining) + self;
    
    };

    def.$rstrip = function() {
      var self = this;

      return self.replace(/\s*$/, '');
    };

    def.$scan = TMP_6 = function(pattern) {
      var $a, self = this, $iter = TMP_6._p, block = $iter || nil;

      TMP_6._p = null;
      
      if (pattern.global) {
        // should we clear it afterwards too?
        pattern.lastIndex = 0;
      }
      else {
        // rewrite regular expression to add the global flag to capture pre/post match
        pattern = new RegExp(pattern.source, 'g' + (pattern.multiline ? 'm' : '') + (pattern.ignoreCase ? 'i' : ''));
      }

      var result = [];
      var match;

      while ((match = pattern.exec(self)) != null) {
        var match_data = (($a = $scope.MatchData) == null ? $opal.cm('MatchData') : $a).$new(pattern, match);
        if (block === nil) {
          match.length == 1 ? result.push(match[0]) : result.push(match.slice(1));
        }
        else {
          match.length == 1 ? block(match[0]) : block.apply(self, match.slice(1));
        }
      }

      return (block !== nil ? self : result);
    
    };

    $opal.defn(self, '$size', def.$length);

    $opal.defn(self, '$slice', def['$[]']);

    def.$split = function(pattern, limit) {
      var $a, self = this;
      if ($gvars[";"] == null) $gvars[";"] = nil;

      if (pattern == null) {
        pattern = ((($a = $gvars[";"]) !== false && $a !== nil) ? $a : " ")
      }
      
      if (pattern === nil || pattern === undefined) {
        pattern = $gvars[";"];
      }

      var result = [];
      if (limit !== undefined) {
        limit = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](limit, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      }

      if (self.length === 0) {
        return [];
      }

      if (limit === 1) {
        return [self];
      }

      if (pattern && pattern._isRegexp) {
        var pattern_str = pattern.toString();

        /* Opal and JS's repr of an empty RE. */
        var blank_pattern = (pattern_str.substr(0, 3) == '/^/') ||
                  (pattern_str.substr(0, 6) == '/(?:)/');

        /* This is our fast path */
        if (limit === undefined || limit === 0) {
          result = self.split(blank_pattern ? /(?:)/ : pattern);
        }
        else {
          /* RegExp.exec only has sane behavior with global flag */
          if (! pattern.global) {
            pattern = eval(pattern_str + 'g');
          }

          var match_data;
          var prev_index = 0;
          pattern.lastIndex = 0;

          while ((match_data = pattern.exec(self)) !== null) {
            var segment = self.slice(prev_index, match_data.index);
            result.push(segment);

            prev_index = pattern.lastIndex;

            if (match_data[0].length === 0) {
              if (blank_pattern) {
                /* explicitly split on JS's empty RE form.*/
                pattern = /(?:)/;
              }

              result = self.split(pattern);
              /* with "unlimited", ruby leaves a trail on blanks. */
              if (limit !== undefined && limit < 0 && blank_pattern) {
                result.push('');
              }

              prev_index = undefined;
              break;
            }

            if (limit !== undefined && limit > 1 && result.length + 1 == limit) {
              break;
            }
          }

          if (prev_index !== undefined) {
            result.push(self.slice(prev_index, self.length));
          }
        }
      }
      else {
        var splitted = 0, start = 0, lim = 0;

        if (pattern === nil || pattern === undefined) {
          pattern = ' '
        } else {
          pattern = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$try_convert(pattern, (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();
        }

        var string = (pattern == ' ') ? self.replace(/[\r\n\t\v]\s+/g, ' ')
                                      : self;
        var cursor = -1;
        while ((cursor = string.indexOf(pattern, start)) > -1 && cursor < string.length) {
          if (splitted + 1 === limit) {
            break;
          }

          if (pattern == ' ' && cursor == start) {
            start = cursor + 1;
            continue;
          }

          result.push(string.substr(start, pattern.length ? cursor - start : 1));
          splitted++;

          start = cursor + (pattern.length ? pattern.length : 1);
        }

        if (string.length > 0 && (limit < 0 || string.length > start)) {
          if (string.length == start) {
            result.push('');
          }
          else {
            result.push(string.substr(start, string.length));
          }
        }
      }

      if (limit === undefined || limit === 0) {
        while (result[result.length-1] === '') {
          result.length = result.length - 1;
        }
      }

      if (limit > 0) {
        var tail = result.slice(limit - 1).join('');
        result.splice(limit - 1, result.length - 1, tail);
      }

      return result;
    ;
    };

    def.$squeeze = function(sets) {
      var $a, self = this;

      sets = $slice.call(arguments, 0);
      
      if (sets.length === 0) {
        return self.replace(/(.)\1+/g, '$1');
      }
    
      
      var set = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(sets[0], (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$chars();

      for (var i = 1, length = sets.length; i < length; i++) {
        set = (set)['$&']((($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(sets[i], (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$chars());
      }

      if (set.length === 0) {
        return self;
      }

      return self.replace(new RegExp("([" + (($a = $scope.Regexp) == null ? $opal.cm('Regexp') : $a).$escape((set).$join()) + "])\\1+", "g"), "$1");
    ;
    };

    def['$start_with?'] = function(prefixes) {
      var $a, self = this;

      prefixes = $slice.call(arguments, 0);
      
      for (var i = 0, length = prefixes.length; i < length; i++) {
        var prefix = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(prefixes[i], (($a = $scope.String) == null ? $opal.cm('String') : $a), "to_str").$to_s();

        if (self.indexOf(prefix) === 0) {
          return true;
        }
      }

      return false;
    
    };

    def.$strip = function() {
      var self = this;

      return self.replace(/^\s*/, '').replace(/\s*$/, '');
    };

    def.$sub = TMP_7 = function(pattern, replace) {
      var $a, self = this, $iter = TMP_7._p, block = $iter || nil;

      TMP_7._p = null;
      
      if (typeof(replace) === 'string') {
        // convert Ruby back reference to JavaScript back reference
        replace = replace.replace(/\\([1-9])/g, '$$$1')
        return self.replace(pattern, replace);
      }
      if (block !== nil) {
        return self.replace(pattern, function() {
          // FIXME: this should be a formal MatchData object with all the goodies
          var match_data = []
          for (var i = 0, len = arguments.length; i < len; i++) {
            var arg = arguments[i];
            if (arg == undefined) {
              match_data.push(nil);
            }
            else {
              match_data.push(arg);
            }
          }

          var str = match_data.pop();
          var offset = match_data.pop();
          var match_len = match_data.length;

          // $1, $2, $3 not being parsed correctly in Ruby code
          //for (var i = 1; i < match_len; i++) {
          //  __gvars[String(i)] = match_data[i];
          //}
          $gvars["&"] = match_data[0];
          $gvars["~"] = match_data;
          return block(match_data[0]);
        });
      }
      else if (replace !== undefined) {
        if (replace['$is_a?']((($a = $scope.Hash) == null ? $opal.cm('Hash') : $a))) {
          return self.replace(pattern, function(str) {
            var value = replace['$[]'](self.$str());

            return (value == null) ? nil : self.$value().$to_s();
          });
        }
        else {
          replace = (($a = $scope.String) == null ? $opal.cm('String') : $a).$try_convert(replace);

          if (replace == null) {
            self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "can't convert " + (replace.$class()) + " into String");
          }

          return self.replace(pattern, replace);
        }
      }
      else {
        // convert Ruby back reference to JavaScript back reference
        replace = replace.toString().replace(/\\([1-9])/g, '$$$1')
        return self.replace(pattern, replace);
      }
    ;
    };

    $opal.defn(self, '$succ', def.$next);

    def.$sum = function(n) {
      var self = this;

      if (n == null) {
        n = 16
      }
      
      var result = 0;

      for (var i = 0, length = self.length; i < length; i++) {
        result += (self.charCodeAt(i) % ((1 << n) - 1));
      }

      return result;
    
    };

    def.$swapcase = function() {
      var self = this;

      
      var str = self.replace(/([a-z]+)|([A-Z]+)/g, function($0,$1,$2) {
        return $1 ? $0.toUpperCase() : $0.toLowerCase();
      });

      if (self.constructor === String) {
        return str;
      }

      return self.$class().$new(str);
    
    };

    def.$to_f = function() {
      var self = this;

      
      if (self.charAt(0) === '_') {
        return 0;
      }

      var result = parseFloat(self.replace(/_/g, ''));

      if (isNaN(result) || result == Infinity || result == -Infinity) {
        return 0;
      }
      else {
        return result;
      }
    
    };

    def.$to_i = function(base) {
      var self = this;

      if (base == null) {
        base = 10
      }
      
      var result = parseInt(self, base);

      if (isNaN(result)) {
        return 0;
      }

      return result;
    
    };

    def.$to_proc = function() {
      var $a, $b, TMP_8, self = this;

      return ($a = ($b = self).$proc, $a._p = (TMP_8 = function(recv, args){var self = TMP_8._s || this, $a;
if (recv == null) recv = nil;args = $slice.call(arguments, 1);
      return ($a = recv).$send.apply($a, [self].concat(args))}, TMP_8._s = self, TMP_8), $a).call($b);
    };

    def.$to_s = function() {
      var self = this;

      return self.toString();
    };

    $opal.defn(self, '$to_str', def.$to_s);

    $opal.defn(self, '$to_sym', def.$intern);

    def.$tr = function(from, to) {
      var self = this;

      
      if (from.length == 0 || from === to) {
        return self;
      }

      var subs = {};
      var from_chars = from.split('');
      var from_length = from_chars.length;
      var to_chars = to.split('');
      var to_length = to_chars.length;

      var inverse = false;
      var global_sub = null;
      if (from_chars[0] === '^') {
        inverse = true;
        from_chars.shift();
        global_sub = to_chars[to_length - 1]
        from_length -= 1;
      }

      var from_chars_expanded = [];
      var last_from = null;
      var in_range = false;
      for (var i = 0; i < from_length; i++) {
        var ch = from_chars[i];
        if (last_from == null) {
          last_from = ch;
          from_chars_expanded.push(ch);
        }
        else if (ch === '-') {
          if (last_from === '-') {
            from_chars_expanded.push('-');
            from_chars_expanded.push('-');
          }
          else if (i == from_length - 1) {
            from_chars_expanded.push('-');
          }
          else {
            in_range = true;
          }
        }
        else if (in_range) {
          var start = last_from.charCodeAt(0) + 1;
          var end = ch.charCodeAt(0);
          for (var c = start; c < end; c++) {
            from_chars_expanded.push(String.fromCharCode(c));
          }
          from_chars_expanded.push(ch);
          in_range = null;
          last_from = null;
        }
        else {
          from_chars_expanded.push(ch);
        }
      }

      from_chars = from_chars_expanded;
      from_length = from_chars.length;

      if (inverse) {
        for (var i = 0; i < from_length; i++) {
          subs[from_chars[i]] = true;
        }
      }
      else {
        if (to_length > 0) {
          var to_chars_expanded = [];
          var last_to = null;
          var in_range = false;
          for (var i = 0; i < to_length; i++) {
            var ch = to_chars[i];
            if (last_from == null) {
              last_from = ch;
              to_chars_expanded.push(ch);
            }
            else if (ch === '-') {
              if (last_to === '-') {
                to_chars_expanded.push('-');
                to_chars_expanded.push('-');
              }
              else if (i == to_length - 1) {
                to_chars_expanded.push('-');
              }
              else {
                in_range = true;
              }
            }
            else if (in_range) {
              var start = last_from.charCodeAt(0) + 1;
              var end = ch.charCodeAt(0);
              for (var c = start; c < end; c++) {
                to_chars_expanded.push(String.fromCharCode(c));
              }
              to_chars_expanded.push(ch);
              in_range = null;
              last_from = null;
            }
            else {
              to_chars_expanded.push(ch);
            }
          }

          to_chars = to_chars_expanded;
          to_length = to_chars.length;
        }

        var length_diff = from_length - to_length;
        if (length_diff > 0) {
          var pad_char = (to_length > 0 ? to_chars[to_length - 1] : '');
          for (var i = 0; i < length_diff; i++) {
            to_chars.push(pad_char);
          }
        }

        for (var i = 0; i < from_length; i++) {
          subs[from_chars[i]] = to_chars[i];
        }
      }

      var new_str = ''
      for (var i = 0, length = self.length; i < length; i++) {
        var ch = self.charAt(i);
        var sub = subs[ch];
        if (inverse) {
          new_str += (sub == null ? global_sub : ch);
        }
        else {
          new_str += (sub != null ? sub : ch);
        }
      }
      return new_str;
    
    };

    def.$tr_s = function(from, to) {
      var self = this;

      
      if (from.length == 0) {
        return self;
      }

      var subs = {};
      var from_chars = from.split('');
      var from_length = from_chars.length;
      var to_chars = to.split('');
      var to_length = to_chars.length;

      var inverse = false;
      var global_sub = null;
      if (from_chars[0] === '^') {
        inverse = true;
        from_chars.shift();
        global_sub = to_chars[to_length - 1]
        from_length -= 1;
      }

      var from_chars_expanded = [];
      var last_from = null;
      var in_range = false;
      for (var i = 0; i < from_length; i++) {
        var ch = from_chars[i];
        if (last_from == null) {
          last_from = ch;
          from_chars_expanded.push(ch);
        }
        else if (ch === '-') {
          if (last_from === '-') {
            from_chars_expanded.push('-');
            from_chars_expanded.push('-');
          }
          else if (i == from_length - 1) {
            from_chars_expanded.push('-');
          }
          else {
            in_range = true;
          }
        }
        else if (in_range) {
          var start = last_from.charCodeAt(0) + 1;
          var end = ch.charCodeAt(0);
          for (var c = start; c < end; c++) {
            from_chars_expanded.push(String.fromCharCode(c));
          }
          from_chars_expanded.push(ch);
          in_range = null;
          last_from = null;
        }
        else {
          from_chars_expanded.push(ch);
        }
      }

      from_chars = from_chars_expanded;
      from_length = from_chars.length;

      if (inverse) {
        for (var i = 0; i < from_length; i++) {
          subs[from_chars[i]] = true;
        }
      }
      else {
        if (to_length > 0) {
          var to_chars_expanded = [];
          var last_to = null;
          var in_range = false;
          for (var i = 0; i < to_length; i++) {
            var ch = to_chars[i];
            if (last_from == null) {
              last_from = ch;
              to_chars_expanded.push(ch);
            }
            else if (ch === '-') {
              if (last_to === '-') {
                to_chars_expanded.push('-');
                to_chars_expanded.push('-');
              }
              else if (i == to_length - 1) {
                to_chars_expanded.push('-');
              }
              else {
                in_range = true;
              }
            }
            else if (in_range) {
              var start = last_from.charCodeAt(0) + 1;
              var end = ch.charCodeAt(0);
              for (var c = start; c < end; c++) {
                to_chars_expanded.push(String.fromCharCode(c));
              }
              to_chars_expanded.push(ch);
              in_range = null;
              last_from = null;
            }
            else {
              to_chars_expanded.push(ch);
            }
          }

          to_chars = to_chars_expanded;
          to_length = to_chars.length;
        }

        var length_diff = from_length - to_length;
        if (length_diff > 0) {
          var pad_char = (to_length > 0 ? to_chars[to_length - 1] : '');
          for (var i = 0; i < length_diff; i++) {
            to_chars.push(pad_char);
          }
        }

        for (var i = 0; i < from_length; i++) {
          subs[from_chars[i]] = to_chars[i];
        }
      }
      var new_str = ''
      var last_substitute = null
      for (var i = 0, length = self.length; i < length; i++) {
        var ch = self.charAt(i);
        var sub = subs[ch]
        if (inverse) {
          if (sub == null) {
            if (last_substitute == null) {
              new_str += global_sub;
              last_substitute = true;
            }
          }
          else {
            new_str += ch;
            last_substitute = null;
          }
        }
        else {
          if (sub != null) {
            if (last_substitute == null || last_substitute !== sub) {
              new_str += sub;
              last_substitute = sub;
            }
          }
          else {
            new_str += ch;
            last_substitute = null;
          }
        }
      }
      return new_str;
    
    };

    def.$upcase = function() {
      var self = this;

      return self.toUpperCase();
    };

    def.$freeze = function() {
      var self = this;

      return self;
    };

    return (def['$frozen?'] = function() {
      var self = this;

      return true;
    }, nil) && 'frozen?';
  })(self, null);
  return $opal.cdecl($scope, 'Symbol', (($a = $scope.String) == null ? $opal.cm('String') : $a));
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$new', '$allocate', '$initialize', '$to_proc', '$__send__', '$class', '$clone', '$respond_to?', '$==', '$inspect']);
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self._proto, $scope = self._scope;

    return ($opal.defs(self, '$inherited', function(klass) {
      var $a, $b, self = this, replace = nil;

      replace = (($a = $scope.Class) == null ? $opal.cm('Class') : $a).$new((($a = ((($b = $scope.String) == null ? $opal.cm('String') : $b))._scope).Wrapper == null ? $a.cm('Wrapper') : $a.Wrapper));
      
      klass._proto        = replace._proto;
      klass._proto._klass = klass;
      klass._alloc        = replace._alloc;
      klass.__parent      = (($a = ((($b = $scope.String) == null ? $opal.cm('String') : $b))._scope).Wrapper == null ? $a.cm('Wrapper') : $a.Wrapper);

      klass.$allocate = replace.$allocate;
      klass.$new      = replace.$new;
    
    }), nil) && 'inherited'
  })(self, null);
  return (function($base, $super) {
    function $Wrapper(){};
    var self = $Wrapper = $klass($base, $super, 'Wrapper', $Wrapper);

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3, TMP_4;

    def.literal = nil;
    $opal.defs(self, '$allocate', TMP_1 = function(string) {
      var self = this, $iter = TMP_1._p, $yield = $iter || nil, obj = nil;

      if (string == null) {
        string = ""
      }
      TMP_1._p = null;
      obj = $opal.find_super_dispatcher(self, 'allocate', TMP_1, null, $Wrapper).apply(self, []);
      obj.literal = string;
      return obj;
    });

    $opal.defs(self, '$new', TMP_2 = function(args) {
      var $a, $b, self = this, $iter = TMP_2._p, block = $iter || nil, obj = nil;

      args = $slice.call(arguments, 0);
      TMP_2._p = null;
      obj = self.$allocate();
      ($a = ($b = obj).$initialize, $a._p = block.$to_proc(), $a).apply($b, [].concat(args));
      return obj;
    });

    $opal.defs(self, '$[]', function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      return self.$allocate(objects);
    });

    def.$initialize = function(string) {
      var self = this;

      if (string == null) {
        string = ""
      }
      return self.literal = string;
    };

    def.$method_missing = TMP_3 = function(args) {
      var $a, $b, self = this, $iter = TMP_3._p, block = $iter || nil, result = nil;

      args = $slice.call(arguments, 0);
      TMP_3._p = null;
      result = ($a = ($b = self.literal).$__send__, $a._p = block.$to_proc(), $a).apply($b, [].concat(args));
      if ((($a = result._isString != null) !== nil && (!$a._isBoolean || $a == true))) {
        if ((($a = result == self.literal) !== nil && (!$a._isBoolean || $a == true))) {
          return self
          } else {
          return self.$class().$allocate(result)
        }
        } else {
        return result
      };
    };

    def.$initialize_copy = function(other) {
      var self = this;

      return self.literal = (other.literal).$clone();
    };

    def['$respond_to?'] = TMP_4 = function(name) {var $zuper = $slice.call(arguments, 0);
      var $a, self = this, $iter = TMP_4._p, $yield = $iter || nil;

      TMP_4._p = null;
      return ((($a = $opal.find_super_dispatcher(self, 'respond_to?', TMP_4, $iter).apply(self, $zuper)) !== false && $a !== nil) ? $a : self.literal['$respond_to?'](name));
    };

    def['$=='] = function(other) {
      var self = this;

      return self.literal['$=='](other);
    };

    $opal.defn(self, '$eql?', def['$==']);

    $opal.defn(self, '$===', def['$==']);

    def.$to_s = function() {
      var self = this;

      return self.literal;
    };

    def.$to_str = function() {
      var self = this;

      return self;
    };

    return (def.$inspect = function() {
      var self = this;

      return self.literal.$inspect();
    }, nil) && 'inspect';
  })((($a = $scope.String) == null ? $opal.cm('String') : $a), null);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$attr_reader', '$pre_match', '$post_match', '$[]', '$===', '$!', '$==', '$raise', '$inspect']);
  return (function($base, $super) {
    function $MatchData(){};
    var self = $MatchData = $klass($base, $super, 'MatchData', $MatchData);

    var def = self._proto, $scope = self._scope, TMP_1;

    def.string = def.matches = def.begin = nil;
    self.$attr_reader("post_match", "pre_match", "regexp", "string");

    $opal.defs(self, '$new', TMP_1 = function(regexp, match_groups) {
      var self = this, $iter = TMP_1._p, $yield = $iter || nil, data = nil;

      TMP_1._p = null;
      data = $opal.find_super_dispatcher(self, 'new', TMP_1, null, $MatchData).apply(self, [regexp, match_groups]);
      $gvars["`"] = data.$pre_match();
      $gvars["'"] = data.$post_match();
      $gvars["~"] = data;
      return data;
    });

    def.$initialize = function(regexp, match_groups) {
      var self = this;

      self.regexp = regexp;
      self.begin = match_groups.index;
      self.string = match_groups.input;
      self.pre_match = self.string.substr(0, regexp.lastIndex - match_groups[0].length);
      self.post_match = self.string.substr(regexp.lastIndex);
      self.matches = [];
      
      for (var i = 0, length = match_groups.length; i < length; i++) {
        var group = match_groups[i];

        if (group == null) {
          self.matches.push(nil);
        }
        else {
          self.matches.push(group);
        }
      }
    
    };

    def['$[]'] = function(args) {
      var $a, self = this;

      args = $slice.call(arguments, 0);
      return ($a = self.matches)['$[]'].apply($a, [].concat(args));
    };

    def['$=='] = function(other) {
      var $a, $b, $c, $d, self = this;

      if ((($a = (($b = $scope.MatchData) == null ? $opal.cm('MatchData') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      return ($a = ($b = ($c = ($d = self.string == other.string, $d !== false && $d !== nil ?self.regexp == other.regexp : $d), $c !== false && $c !== nil ?self.pre_match == other.pre_match : $c), $b !== false && $b !== nil ?self.post_match == other.post_match : $b), $a !== false && $a !== nil ?self.begin == other.begin : $a);
    };

    def.$begin = function(pos) {
      var $a, $b, self = this;

      if ((($a = ($b = pos['$=='](0)['$!'](), $b !== false && $b !== nil ?pos['$=='](1)['$!']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "MatchData#begin only supports 0th element")};
      return self.begin;
    };

    def.$captures = function() {
      var self = this;

      return self.matches.slice(1);
    };

    def.$inspect = function() {
      var self = this;

      
      var str = "#<MatchData " + (self.matches[0]).$inspect();

      for (var i = 1, length = self.matches.length; i < length; i++) {
        str += " " + i + ":" + (self.matches[i]).$inspect();
      }

      return str + ">";
    ;
    };

    def.$length = function() {
      var self = this;

      return self.matches.length;
    };

    $opal.defn(self, '$size', def.$length);

    def.$to_a = function() {
      var self = this;

      return self.matches;
    };

    def.$to_s = function() {
      var self = this;

      return self.matches[0];
    };

    return (def.$values_at = function(indexes) {
      var self = this;

      indexes = $slice.call(arguments, 0);
      
      var values       = [],
          match_length = self.matches.length;

      for (var i = 0, length = indexes.length; i < length; i++) {
        var pos = indexes[i];

        if (pos >= 0) {
          values.push(self.matches[pos]);
        }
        else {
          pos += match_length;

          if (pos > 0) {
            values.push(self.matches[pos]);
          }
          else {
            values.push(nil);
          }
        }
      }

      return values;
    ;
    }, nil) && 'values_at';
  })(self, null)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$coerce', '$===', '$raise', '$class', '$__send__', '$send_coerced', '$to_int', '$coerce_to!', '$-@', '$**', '$-', '$respond_to?', '$==', '$enum_for', '$gcd', '$lcm', '$<', '$>', '$floor', '$/', '$%']);
  ;
  (function($base, $super) {
    function $Numeric(){};
    var self = $Numeric = $klass($base, $super, 'Numeric', $Numeric);

    var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6;

    self.$include((($a = $scope.Comparable) == null ? $opal.cm('Comparable') : $a));

    def._isNumber = true;

    def.$coerce = function(other, type) {
      var $a, self = this, $case = nil;

      if (type == null) {
        type = "operation"
      }
      try {
      
      if (other._isNumber) {
        return [self, other];
      }
      else {
        return other.$coerce(self);
      }
    
      } catch ($err) {if (true) {
        return (function() {$case = type;if ("operation"['$===']($case)) {return self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "" + (other.$class()) + " can't be coerce into Numeric")}else if ("comparison"['$===']($case)) {return self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")}else { return nil }})()
        }else { throw $err; }
      };
    };

    def.$send_coerced = function(method, other) {
      var $a, self = this, type = nil, $case = nil, a = nil, b = nil;

      type = (function() {$case = method;if ("+"['$===']($case) || "-"['$===']($case) || "*"['$===']($case) || "/"['$===']($case) || "%"['$===']($case) || "&"['$===']($case) || "|"['$===']($case) || "^"['$===']($case) || "**"['$===']($case)) {return "operation"}else if (">"['$===']($case) || ">="['$===']($case) || "<"['$===']($case) || "<="['$===']($case) || "<=>"['$===']($case)) {return "comparison"}else { return nil }})();
      $a = $opal.to_ary(self.$coerce(other, type)), a = ($a[0] == null ? nil : $a[0]), b = ($a[1] == null ? nil : $a[1]);
      return a.$__send__(method, b);
    };

    def['$+'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self + other;
      }
      else {
        return self.$send_coerced("+", other);
      }
    
    };

    def['$-'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self - other;
      }
      else {
        return self.$send_coerced("-", other);
      }
    
    };

    def['$*'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self * other;
      }
      else {
        return self.$send_coerced("*", other);
      }
    
    };

    def['$/'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self / other;
      }
      else {
        return self.$send_coerced("/", other);
      }
    
    };

    def['$%'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        if (other < 0 || self < 0) {
          return (self % other + other) % other;
        }
        else {
          return self % other;
        }
      }
      else {
        return self.$send_coerced("%", other);
      }
    
    };

    def['$&'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self & other;
      }
      else {
        return self.$send_coerced("&", other);
      }
    
    };

    def['$|'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self | other;
      }
      else {
        return self.$send_coerced("|", other);
      }
    
    };

    def['$^'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self ^ other;
      }
      else {
        return self.$send_coerced("^", other);
      }
    
    };

    def['$<'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self < other;
      }
      else {
        return self.$send_coerced("<", other);
      }
    
    };

    def['$<='] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self <= other;
      }
      else {
        return self.$send_coerced("<=", other);
      }
    
    };

    def['$>'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self > other;
      }
      else {
        return self.$send_coerced(">", other);
      }
    
    };

    def['$>='] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self >= other;
      }
      else {
        return self.$send_coerced(">=", other);
      }
    
    };

    def['$<=>'] = function(other) {
      var $a, self = this;

      try {
      
      if (other._isNumber) {
        return self > other ? 1 : (self < other ? -1 : 0);
      }
      else {
        return self.$send_coerced("<=>", other);
      }
    
      } catch ($err) {if ($opal.$rescue($err, [(($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a)])) {
        return nil
        }else { throw $err; }
      };
    };

    def['$<<'] = function(count) {
      var self = this;

      return self << count.$to_int();
    };

    def['$>>'] = function(count) {
      var self = this;

      return self >> count.$to_int();
    };

    def['$[]'] = function(bit) {
      var $a, self = this, min = nil, max = nil;

      bit = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a)['$coerce_to!'](bit, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      min = ((2)['$**'](30))['$-@']();
      max = ((2)['$**'](30))['$-'](1);
      return (bit < min || bit > max) ? 0 : (self >> bit) % 2;
    };

    def['$+@'] = function() {
      var self = this;

      return +self;
    };

    def['$-@'] = function() {
      var self = this;

      return -self;
    };

    def['$~'] = function() {
      var self = this;

      return ~self;
    };

    def['$**'] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return Math.pow(self, other);
      }
      else {
        return self.$send_coerced("**", other);
      }
    
    };

    def['$=='] = function(other) {
      var self = this;

      
      if (other._isNumber) {
        return self == Number(other);
      }
      else if (other['$respond_to?']("==")) {
        return other['$=='](self);
      }
      else {
        return false;
      }
    ;
    };

    def.$abs = function() {
      var self = this;

      return Math.abs(self);
    };

    def.$ceil = function() {
      var self = this;

      return Math.ceil(self);
    };

    def.$chr = function() {
      var self = this;

      return String.fromCharCode(self);
    };

    def.$conj = function() {
      var self = this;

      return self;
    };

    $opal.defn(self, '$conjugate', def.$conj);

    def.$downto = TMP_1 = function(finish) {
      var self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("downto", finish)
      };
      
      for (var i = self; i >= finish; i--) {
        if (block(i) === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    $opal.defn(self, '$eql?', def['$==']);

    $opal.defn(self, '$equal?', def['$==']);

    def['$even?'] = function() {
      var self = this;

      return self % 2 === 0;
    };

    def.$floor = function() {
      var self = this;

      return Math.floor(self);
    };

    def.$gcd = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Integer) == null ? $opal.cm('Integer') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "not an integer")
      };
      
      var min = Math.abs(self),
          max = Math.abs(other);

      while (min > 0) {
        var tmp = min;

        min = max % min;
        max = tmp;
      }

      return max;
    
    };

    def.$gcdlcm = function(other) {
      var self = this;

      return [self.$gcd(), self.$lcm()];
    };

    def.$hash = function() {
      var self = this;

      return self.toString();
    };

    def['$integer?'] = function() {
      var self = this;

      return self % 1 === 0;
    };

    def['$is_a?'] = TMP_2 = function(klass) {var $zuper = $slice.call(arguments, 0);
      var $a, $b, $c, self = this, $iter = TMP_2._p, $yield = $iter || nil;

      TMP_2._p = null;
      if ((($a = (($b = klass['$==']((($c = $scope.Fixnum) == null ? $opal.cm('Fixnum') : $c))) ? (($c = $scope.Integer) == null ? $opal.cm('Integer') : $c)['$==='](self) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']((($c = $scope.Integer) == null ? $opal.cm('Integer') : $c))) ? (($c = $scope.Integer) == null ? $opal.cm('Integer') : $c)['$==='](self) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']((($c = $scope.Float) == null ? $opal.cm('Float') : $c))) ? (($c = $scope.Float) == null ? $opal.cm('Float') : $c)['$==='](self) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      return $opal.find_super_dispatcher(self, 'is_a?', TMP_2, $iter).apply(self, $zuper);
    };

    $opal.defn(self, '$kind_of?', def['$is_a?']);

    def['$instance_of?'] = TMP_3 = function(klass) {var $zuper = $slice.call(arguments, 0);
      var $a, $b, $c, self = this, $iter = TMP_3._p, $yield = $iter || nil;

      TMP_3._p = null;
      if ((($a = (($b = klass['$==']((($c = $scope.Fixnum) == null ? $opal.cm('Fixnum') : $c))) ? (($c = $scope.Integer) == null ? $opal.cm('Integer') : $c)['$==='](self) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']((($c = $scope.Integer) == null ? $opal.cm('Integer') : $c))) ? (($c = $scope.Integer) == null ? $opal.cm('Integer') : $c)['$==='](self) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']((($c = $scope.Float) == null ? $opal.cm('Float') : $c))) ? (($c = $scope.Float) == null ? $opal.cm('Float') : $c)['$==='](self) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return true};
      return $opal.find_super_dispatcher(self, 'instance_of?', TMP_3, $iter).apply(self, $zuper);
    };

    def.$lcm = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Integer) == null ? $opal.cm('Integer') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "not an integer")
      };
      
      if (self == 0 || other == 0) {
        return 0;
      }
      else {
        return Math.abs(self * other / self.$gcd(other));
      }
    
    };

    $opal.defn(self, '$magnitude', def.$abs);

    $opal.defn(self, '$modulo', def['$%']);

    def.$next = function() {
      var self = this;

      return self + 1;
    };

    def['$nonzero?'] = function() {
      var self = this;

      return self == 0 ? nil : self;
    };

    def['$odd?'] = function() {
      var self = this;

      return self % 2 !== 0;
    };

    def.$ord = function() {
      var self = this;

      return self;
    };

    def.$pred = function() {
      var self = this;

      return self - 1;
    };

    def.$round = function() {
      var self = this;

      return Math.round(self);
    };

    def.$step = TMP_4 = function(limit, step) {
      var $a, self = this, $iter = TMP_4._p, block = $iter || nil;

      if (step == null) {
        step = 1
      }
      TMP_4._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("step", limit, step)
      };
      if ((($a = step == 0) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "step cannot be 0")};
      
      var value = self;

      if (step > 0) {
        while (value <= limit) {
          block(value);
          value += step;
        }
      }
      else {
        while (value >= limit) {
          block(value);
          value += step;
        }
      }
    
      return self;
    };

    $opal.defn(self, '$succ', def.$next);

    def.$times = TMP_5 = function() {
      var self = this, $iter = TMP_5._p, block = $iter || nil;

      TMP_5._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("times")
      };
      
      for (var i = 0; i < self; i++) {
        if (block(i) === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def.$to_f = function() {
      var self = this;

      return self;
    };

    def.$to_i = function() {
      var self = this;

      return parseInt(self);
    };

    $opal.defn(self, '$to_int', def.$to_i);

    def.$to_s = function(base) {
      var $a, $b, self = this;

      if (base == null) {
        base = 10
      }
      if ((($a = ((($b = base['$<'](2)) !== false && $b !== nil) ? $b : base['$>'](36))) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "base must be between 2 and 36")};
      return self.toString(base);
    };

    $opal.defn(self, '$inspect', def.$to_s);

    def.$divmod = function(rhs) {
      var self = this, q = nil, r = nil;

      q = (self['$/'](rhs)).$floor();
      r = self['$%'](rhs);
      return [q, r];
    };

    def.$upto = TMP_6 = function(finish) {
      var self = this, $iter = TMP_6._p, block = $iter || nil;

      TMP_6._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("upto", finish)
      };
      
      for (var i = self; i <= finish; i++) {
        if (block(i) === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def['$zero?'] = function() {
      var self = this;

      return self == 0;
    };

    def.$size = function() {
      var self = this;

      return 4;
    };

    def['$nan?'] = function() {
      var self = this;

      return isNaN(self);
    };

    def['$finite?'] = function() {
      var self = this;

      return self != Infinity && self != -Infinity;
    };

    def['$infinite?'] = function() {
      var self = this;

      
      if (self == Infinity) {
        return +1;
      }
      else if (self == -Infinity) {
        return -1;
      }
      else {
        return nil;
      }
    
    };

    def['$positive?'] = function() {
      var self = this;

      return 1 / self > 0;
    };

    return (def['$negative?'] = function() {
      var self = this;

      return 1 / self < 0;
    }, nil) && 'negative?';
  })(self, null);
  $opal.cdecl($scope, 'Fixnum', (($a = $scope.Numeric) == null ? $opal.cm('Numeric') : $a));
  (function($base, $super) {
    function $Integer(){};
    var self = $Integer = $klass($base, $super, 'Integer', $Integer);

    var def = self._proto, $scope = self._scope;

    return ($opal.defs(self, '$===', function(other) {
      var self = this;

      
      if (!other._isNumber) {
        return false;
      }

      return (other % 1) === 0;
    
    }), nil) && '==='
  })(self, (($a = $scope.Numeric) == null ? $opal.cm('Numeric') : $a));
  return (function($base, $super) {
    function $Float(){};
    var self = $Float = $klass($base, $super, 'Float', $Float);

    var def = self._proto, $scope = self._scope, $a;

    $opal.defs(self, '$===', function(other) {
      var self = this;

      return !!other._isNumber;
    });

    $opal.cdecl($scope, 'INFINITY', Infinity);

    $opal.cdecl($scope, 'NAN', NaN);

    if ((($a = (typeof(Number.EPSILON) !== "undefined")) !== nil && (!$a._isBoolean || $a == true))) {
      return $opal.cdecl($scope, 'EPSILON', Number.EPSILON)
      } else {
      return $opal.cdecl($scope, 'EPSILON', 2.2204460492503130808472633361816E-16)
    };
  })(self, (($a = $scope.Numeric) == null ? $opal.cm('Numeric') : $a));
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs([]);
  return (function($base, $super) {
    function $Complex(){};
    var self = $Complex = $klass($base, $super, 'Complex', $Complex);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.Numeric) == null ? $opal.cm('Numeric') : $a))
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs([]);
  return (function($base, $super) {
    function $Rational(){};
    var self = $Rational = $klass($base, $super, 'Rational', $Rational);

    var def = self._proto, $scope = self._scope;

    return nil;
  })(self, (($a = $scope.Numeric) == null ? $opal.cm('Numeric') : $a))
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$raise']);
  return (function($base, $super) {
    function $Proc(){};
    var self = $Proc = $klass($base, $super, 'Proc', $Proc);

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2;

    def._isProc = true;

    def.is_lambda = false;

    $opal.defs(self, '$new', TMP_1 = function() {
      var $a, self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      if (block !== false && block !== nil) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "tried to create a Proc object without a block")
      };
      return block;
    });

    def.$call = TMP_2 = function(args) {
      var self = this, $iter = TMP_2._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_2._p = null;
      
      if (block !== nil) {
        self._p = block;
      }

      var result;

      if (self.is_lambda) {
        result = self.apply(null, args);
      }
      else {
        result = Opal.$yieldX(self, args);
      }

      if (result === $breaker) {
        return $breaker.$v;
      }

      return result;
    
    };

    $opal.defn(self, '$[]', def.$call);

    def.$to_proc = function() {
      var self = this;

      return self;
    };

    def['$lambda?'] = function() {
      var self = this;

      return !!self.is_lambda;
    };

    return (def.$arity = function() {
      var self = this;

      return self.length;
    }, nil) && 'arity';
  })(self, null)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$attr_reader', '$class', '$arity', '$new', '$name']);
  (function($base, $super) {
    function $Method(){};
    var self = $Method = $klass($base, $super, 'Method', $Method);

    var def = self._proto, $scope = self._scope, TMP_1;

    def.method = def.receiver = def.owner = def.name = def.obj = nil;
    self.$attr_reader("owner", "receiver", "name");

    def.$initialize = function(receiver, method, name) {
      var self = this;

      self.receiver = receiver;
      self.owner = receiver.$class();
      self.name = name;
      return self.method = method;
    };

    def.$arity = function() {
      var self = this;

      return self.method.$arity();
    };

    def.$call = TMP_1 = function(args) {
      var self = this, $iter = TMP_1._p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_1._p = null;
      
      self.method._p = block;

      return self.method.apply(self.receiver, args);
    ;
    };

    $opal.defn(self, '$[]', def.$call);

    def.$unbind = function() {
      var $a, self = this;

      return (($a = $scope.UnboundMethod) == null ? $opal.cm('UnboundMethod') : $a).$new(self.owner, self.method, self.name);
    };

    def.$to_proc = function() {
      var self = this;

      return self.method;
    };

    return (def.$inspect = function() {
      var self = this;

      return "#<Method: " + (self.obj.$class().$name()) + "#" + (self.name) + "}>";
    }, nil) && 'inspect';
  })(self, null);
  return (function($base, $super) {
    function $UnboundMethod(){};
    var self = $UnboundMethod = $klass($base, $super, 'UnboundMethod', $UnboundMethod);

    var def = self._proto, $scope = self._scope;

    def.method = def.name = def.owner = nil;
    self.$attr_reader("owner", "name");

    def.$initialize = function(owner, method, name) {
      var self = this;

      self.owner = owner;
      self.method = method;
      return self.name = name;
    };

    def.$arity = function() {
      var self = this;

      return self.method.$arity();
    };

    def.$bind = function(object) {
      var $a, self = this;

      return (($a = $scope.Method) == null ? $opal.cm('Method') : $a).$new(object, self.method, self.name);
    };

    return (def.$inspect = function() {
      var self = this;

      return "#<UnboundMethod: " + (self.owner.$name()) + "#" + (self.name) + ">";
    }, nil) && 'inspect';
  })(self, null);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$attr_reader', '$<=', '$<', '$enum_for', '$succ', '$!', '$==', '$===', '$exclude_end?', '$eql?', '$begin', '$end', '$-', '$abs', '$to_i', '$raise', '$inspect']);
  ;
  return (function($base, $super) {
    function $Range(){};
    var self = $Range = $klass($base, $super, 'Range', $Range);

    var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2, TMP_3;

    def.begin = def.exclude = def.end = nil;
    self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

    def._isRange = true;

    self.$attr_reader("begin", "end");

    def.$initialize = function(first, last, exclude) {
      var self = this;

      if (exclude == null) {
        exclude = false
      }
      self.begin = first;
      self.end = last;
      return self.exclude = exclude;
    };

    def['$=='] = function(other) {
      var self = this;

      
      if (!other._isRange) {
        return false;
      }

      return self.exclude === other.exclude &&
             self.begin   ==  other.begin &&
             self.end     ==  other.end;
    
    };

    def['$==='] = function(value) {
      var $a, $b, self = this;

      return (($a = self.begin['$<='](value)) ? ((function() {if ((($b = self.exclude) !== nil && (!$b._isBoolean || $b == true))) {
        return value['$<'](self.end)
        } else {
        return value['$<='](self.end)
      }; return nil; })()) : $a);
    };

    $opal.defn(self, '$cover?', def['$===']);

    def.$each = TMP_1 = function() {
      var $a, $b, self = this, $iter = TMP_1._p, block = $iter || nil, current = nil, last = nil;

      TMP_1._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each")
      };
      current = self.begin;
      last = self.end;
      while (current['$<'](last)) {
      if ($opal.$yield1(block, current) === $breaker) return $breaker.$v;
      current = current.$succ();};
      if ((($a = ($b = self.exclude['$!'](), $b !== false && $b !== nil ?current['$=='](last) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        if ($opal.$yield1(block, current) === $breaker) return $breaker.$v};
      return self;
    };

    def['$eql?'] = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Range) == null ? $opal.cm('Range') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      return ($a = ($b = self.exclude['$==='](other['$exclude_end?']()), $b !== false && $b !== nil ?self.begin['$eql?'](other.$begin()) : $b), $a !== false && $a !== nil ?self.end['$eql?'](other.$end()) : $a);
    };

    def['$exclude_end?'] = function() {
      var self = this;

      return self.exclude;
    };

    $opal.defn(self, '$first', def.$begin);

    $opal.defn(self, '$include?', def['$cover?']);

    $opal.defn(self, '$last', def.$end);

    def.$max = TMP_2 = function() {var $zuper = $slice.call(arguments, 0);
      var self = this, $iter = TMP_2._p, $yield = $iter || nil;

      TMP_2._p = null;
      if (($yield !== nil)) {
        return $opal.find_super_dispatcher(self, 'max', TMP_2, $iter).apply(self, $zuper)
        } else {
        return self.exclude ? self.end - 1 : self.end;
      };
    };

    $opal.defn(self, '$member?', def['$cover?']);

    def.$min = TMP_3 = function() {var $zuper = $slice.call(arguments, 0);
      var self = this, $iter = TMP_3._p, $yield = $iter || nil;

      TMP_3._p = null;
      if (($yield !== nil)) {
        return $opal.find_super_dispatcher(self, 'min', TMP_3, $iter).apply(self, $zuper)
        } else {
        return self.begin
      };
    };

    $opal.defn(self, '$member?', def['$include?']);

    def.$size = function() {
      var $a, $b, $c, self = this, _begin = nil, _end = nil, infinity = nil;

      _begin = self.begin;
      _end = self.end;
      if ((($a = self.exclude) !== nil && (!$a._isBoolean || $a == true))) {
        _end = _end['$-'](1)};
      if ((($a = ($b = (($c = $scope.Numeric) == null ? $opal.cm('Numeric') : $c)['$==='](_begin), $b !== false && $b !== nil ?(($c = $scope.Numeric) == null ? $opal.cm('Numeric') : $c)['$==='](_end) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return nil
      };
      if (_end['$<'](_begin)) {
        return 0};
      infinity = (($a = ((($b = $scope.Float) == null ? $opal.cm('Float') : $b))._scope).INFINITY == null ? $a.cm('INFINITY') : $a.INFINITY);
      if ((($a = ((($b = infinity['$=='](_begin.$abs())) !== false && $b !== nil) ? $b : _end.$abs()['$=='](infinity))) !== nil && (!$a._isBoolean || $a == true))) {
        return infinity};
      return ((Math.abs(_end - _begin) + 1)).$to_i();
    };

    def.$step = function(n) {
      var $a, self = this;

      if (n == null) {
        n = 1
      }
      return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
    };

    def.$to_s = function() {
      var self = this;

      return self.begin.$inspect() + (self.exclude ? '...' : '..') + self.end.$inspect();
    };

    return $opal.defn(self, '$inspect', def.$to_s);
  })(self, null);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$kind_of?', '$to_i', '$coerce_to', '$between?', '$raise', '$new', '$compact', '$nil?', '$===', '$<=>', '$to_f', '$strftime', '$is_a?', '$zero?', '$utc?', '$warn', '$yday', '$rjust', '$ljust', '$zone', '$sec', '$min', '$hour', '$day', '$month', '$year', '$wday', '$isdst']);
  ;
  return (function($base, $super) {
    function $Time(){};
    var self = $Time = $klass($base, $super, 'Time', $Time);

    var def = self._proto, $scope = self._scope, $a;

    self.$include((($a = $scope.Comparable) == null ? $opal.cm('Comparable') : $a));

    
    var days_of_week = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
        short_days   = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        short_months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
        long_months  = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  ;

    $opal.defs(self, '$at', function(seconds, frac) {
      var self = this;

      if (frac == null) {
        frac = 0
      }
      return new Date(seconds * 1000 + frac);
    });

    $opal.defs(self, '$new', function(year, month, day, hour, minute, second, utc_offset) {
      var self = this;

      
      switch (arguments.length) {
        case 1:
          return new Date(year, 0);

        case 2:
          return new Date(year, month - 1);

        case 3:
          return new Date(year, month - 1, day);

        case 4:
          return new Date(year, month - 1, day, hour);

        case 5:
          return new Date(year, month - 1, day, hour, minute);

        case 6:
          return new Date(year, month - 1, day, hour, minute, second);

        case 7:
          return new Date(year, month - 1, day, hour, minute, second);

        default:
          return new Date();
      }
    
    });

    $opal.defs(self, '$local', function(year, month, day, hour, minute, second, millisecond) {
      var $a, $b, self = this;

      if (month == null) {
        month = nil
      }
      if (day == null) {
        day = nil
      }
      if (hour == null) {
        hour = nil
      }
      if (minute == null) {
        minute = nil
      }
      if (second == null) {
        second = nil
      }
      if (millisecond == null) {
        millisecond = nil
      }
      if ((($a = arguments.length === 10) !== nil && (!$a._isBoolean || $a == true))) {
        
        var args = $slice.call(arguments).reverse();

        second = args[9];
        minute = args[8];
        hour   = args[7];
        day    = args[6];
        month  = args[5];
        year   = args[4];
      };
      year = (function() {if ((($a = year['$kind_of?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        return year.$to_i()
        } else {
        return (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(year, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")
      }; return nil; })();
      month = (function() {if ((($a = month['$kind_of?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        return month.$to_i()
        } else {
        return (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(((($a = month) !== false && $a !== nil) ? $a : 1), (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")
      }; return nil; })();
      if ((($a = month['$between?'](1, 12)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "month out of range: " + (month))
      };
      day = (function() {if ((($a = day['$kind_of?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        return day.$to_i()
        } else {
        return (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(((($a = day) !== false && $a !== nil) ? $a : 1), (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")
      }; return nil; })();
      if ((($a = day['$between?'](1, 31)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "day out of range: " + (day))
      };
      hour = (function() {if ((($a = hour['$kind_of?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        return hour.$to_i()
        } else {
        return (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(((($a = hour) !== false && $a !== nil) ? $a : 0), (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")
      }; return nil; })();
      if ((($a = hour['$between?'](0, 24)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "hour out of range: " + (hour))
      };
      minute = (function() {if ((($a = minute['$kind_of?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        return minute.$to_i()
        } else {
        return (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(((($a = minute) !== false && $a !== nil) ? $a : 0), (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")
      }; return nil; })();
      if ((($a = minute['$between?'](0, 59)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "minute out of range: " + (minute))
      };
      second = (function() {if ((($a = second['$kind_of?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        return second.$to_i()
        } else {
        return (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(((($a = second) !== false && $a !== nil) ? $a : 0), (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int")
      }; return nil; })();
      if ((($a = second['$between?'](0, 59)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "second out of range: " + (second))
      };
      return ($a = self).$new.apply($a, [].concat([year, month, day, hour, minute, second].$compact()));
    });

    $opal.defs(self, '$gm', function(year, month, day, hour, minute, second, utc_offset) {
      var $a, self = this;

      if ((($a = year['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "missing year (got nil)")};
      
      if (month > 12 || day > 31 || hour > 24 || minute > 59 || second > 59) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a));
      }

      var date = new Date(Date.UTC(year, (month || 1) - 1, (day || 1), (hour || 0), (minute || 0), (second || 0)));
      date.tz_offset = 0
      return date;
    ;
    });

    (function(self) {
      var $scope = self._scope, def = self._proto;

      self._proto.$mktime = self._proto.$local;
      return self._proto.$utc = self._proto.$gm;
    })(self.$singleton_class());

    $opal.defs(self, '$now', function() {
      var self = this;

      return new Date();
    });

    def['$+'] = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Time) == null ? $opal.cm('Time') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.TypeError) == null ? $opal.cm('TypeError') : $a), "time + time?")};
      other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
      
      var result = new Date(self.getTime() + (other * 1000));
      result.tz_offset = self.tz_offset;
      return result;
    
    };

    def['$-'] = function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Time) == null ? $opal.cm('Time') : $b)['$==='](other)) !== nil && (!$a._isBoolean || $a == true))) {
        return (self.getTime() - other.getTime()) / 1000;
        } else {
        other = (($a = $scope.Opal) == null ? $opal.cm('Opal') : $a).$coerce_to(other, (($a = $scope.Integer) == null ? $opal.cm('Integer') : $a), "to_int");
        
        var result = new Date(self.getTime() - (other * 1000));
        result.tz_offset = self.tz_offset;
        return result;
      
      };
    };

    def['$<=>'] = function(other) {
      var self = this;

      return self.$to_f()['$<=>'](other.$to_f());
    };

    def['$=='] = function(other) {
      var self = this;

      return self.$to_f() === other.$to_f();
    };

    def.$asctime = function() {
      var self = this;

      return self.$strftime("%a %b %e %H:%M:%S %Y");
    };

    $opal.defn(self, '$ctime', def.$asctime);

    def.$day = function() {
      var self = this;

      return self.getDate();
    };

    def.$yday = function() {
      var self = this;

      
      // http://javascript.about.com/library/bldayyear.htm
      var onejan = new Date(self.getFullYear(), 0, 1);
      return Math.ceil((self - onejan) / 86400000);
    
    };

    def.$isdst = function() {
      var $a, self = this;

      return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
    };

    def['$eql?'] = function(other) {
      var $a, $b, self = this;

      return ($a = other['$is_a?']((($b = $scope.Time) == null ? $opal.cm('Time') : $b)), $a !== false && $a !== nil ?(self['$<=>'](other))['$zero?']() : $a);
    };

    def['$friday?'] = function() {
      var self = this;

      return self.getDay() === 5;
    };

    def.$hour = function() {
      var self = this;

      return self.getHours();
    };

    def.$inspect = function() {
      var $a, self = this;

      if ((($a = self['$utc?']()) !== nil && (!$a._isBoolean || $a == true))) {
        return self.$strftime("%Y-%m-%d %H:%M:%S UTC")
        } else {
        return self.$strftime("%Y-%m-%d %H:%M:%S %z")
      };
    };

    $opal.defn(self, '$mday', def.$day);

    def.$min = function() {
      var self = this;

      return self.getMinutes();
    };

    def.$mon = function() {
      var self = this;

      return self.getMonth() + 1;
    };

    def['$monday?'] = function() {
      var self = this;

      return self.getDay() === 1;
    };

    $opal.defn(self, '$month', def.$mon);

    def['$saturday?'] = function() {
      var self = this;

      return self.getDay() === 6;
    };

    def.$sec = function() {
      var self = this;

      return self.getSeconds();
    };

    def.$usec = function() {
      var self = this;

      self.$warn("Microseconds are not supported");
      return 0;
    };

    def.$zone = function() {
      var self = this;

      
      var string = self.toString(),
          result;

      if (string.indexOf('(') == -1) {
        result = string.match(/[A-Z]{3,4}/)[0];
      }
      else {
        result = string.match(/\([^)]+\)/)[0].match(/[A-Z]/g).join('');
      }

      if (result == "GMT" && /(GMT\W*\d{4})/.test(string)) {
        return RegExp.$1;
      }
      else {
        return result;
      }
    
    };

    def.$getgm = function() {
      var self = this;

      
      var result = new Date(self.getTime());
      result.tz_offset = 0;
      return result;
    
    };

    def['$gmt?'] = function() {
      var self = this;

      return self.tz_offset == 0;
    };

    def.$gmt_offset = function() {
      var self = this;

      return -self.getTimezoneOffset() * 60;
    };

    def.$strftime = function(format) {
      var self = this;

      
      return format.replace(/%([\-_#^0]*:{0,2})(\d+)?([EO]*)(.)/g, function(full, flags, width, _, conv) {
        var result = "",
            width  = parseInt(width),
            zero   = flags.indexOf('0') !== -1,
            pad    = flags.indexOf('-') === -1,
            blank  = flags.indexOf('_') !== -1,
            upcase = flags.indexOf('^') !== -1,
            invert = flags.indexOf('#') !== -1,
            colons = (flags.match(':') || []).length;

        if (zero && blank) {
          if (flags.indexOf('0') < flags.indexOf('_')) {
            zero = false;
          }
          else {
            blank = false;
          }
        }

        switch (conv) {
          case 'Y':
            result += self.getFullYear();
            break;

          case 'C':
            zero    = !blank;
            result += Match.round(self.getFullYear() / 100);
            break;

          case 'y':
            zero    = !blank;
            result += (self.getFullYear() % 100);
            break;

          case 'm':
            zero    = !blank;
            result += (self.getMonth() + 1);
            break;

          case 'B':
            result += long_months[self.getMonth()];
            break;

          case 'b':
          case 'h':
            blank   = !zero;
            result += short_months[self.getMonth()];
            break;

          case 'd':
            zero    = !blank
            result += self.getDate();
            break;

          case 'e':
            blank   = !zero
            result += self.getDate();
            break;

          case 'j':
            result += self.$yday();
            break;

          case 'H':
            zero    = !blank;
            result += self.getHours();
            break;

          case 'k':
            blank   = !zero;
            result += self.getHours();
            break;

          case 'I':
            zero    = !blank;
            result += (self.getHours() % 12 || 12);
            break;

          case 'l':
            blank   = !zero;
            result += (self.getHours() % 12 || 12);
            break;

          case 'P':
            result += (self.getHours() >= 12 ? "pm" : "am");
            break;

          case 'p':
            result += (self.getHours() >= 12 ? "PM" : "AM");
            break;

          case 'M':
            zero    = !blank;
            result += self.getMinutes();
            break;

          case 'S':
            zero    = !blank;
            result += self.getSeconds();
            break;

          case 'L':
            zero    = !blank;
            width   = isNaN(width) ? 3 : width;
            result += self.getMilliseconds();
            break;

          case 'N':
            width   = isNaN(width) ? 9 : width;
            result += (self.getMilliseconds().toString()).$rjust(3, "0");
            result  = (result).$ljust(width, "0");
            break;

          case 'z':
            var offset  = self.getTimezoneOffset(),
                hours   = Math.floor(Math.abs(offset) / 60),
                minutes = Math.abs(offset) % 60;

            result += offset < 0 ? "+" : "-";
            result += hours < 10 ? "0" : "";
            result += hours;

            if (colons > 0) {
              result += ":";
            }

            result += minutes < 10 ? "0" : "";
            result += minutes;

            if (colons > 1) {
              result += ":00";
            }

            break;

          case 'Z':
            result += self.$zone();
            break;

          case 'A':
            result += days_of_week[self.getDay()];
            break;

          case 'a':
            result += short_days[self.getDay()];
            break;

          case 'u':
            result += (self.getDay() + 1);
            break;

          case 'w':
            result += self.getDay();
            break;

          // TODO: week year
          // TODO: week number

          case 's':
            result += parseInt(self.getTime() / 1000)
            break;

          case 'n':
            result += "\n";
            break;

          case 't':
            result += "\t";
            break;

          case '%':
            result += "%";
            break;

          case 'c':
            result += self.$strftime("%a %b %e %T %Y");
            break;

          case 'D':
          case 'x':
            result += self.$strftime("%m/%d/%y");
            break;

          case 'F':
            result += self.$strftime("%Y-%m-%d");
            break;

          case 'v':
            result += self.$strftime("%e-%^b-%4Y");
            break;

          case 'r':
            result += self.$strftime("%I:%M:%S %p");
            break;

          case 'R':
            result += self.$strftime("%H:%M");
            break;

          case 'T':
          case 'X':
            result += self.$strftime("%H:%M:%S");
            break;

          default:
            return full;
        }

        if (upcase) {
          result = result.toUpperCase();
        }

        if (invert) {
          result = result.replace(/[A-Z]/, function(c) { c.toLowerCase() }).
                          replace(/[a-z]/, function(c) { c.toUpperCase() });
        }

        if (pad && (zero || blank)) {
          result = (result).$rjust(isNaN(width) ? 2 : width, blank ? " " : "0");
        }

        return result;
      });
    
    };

    def['$sunday?'] = function() {
      var self = this;

      return self.getDay() === 0;
    };

    def['$thursday?'] = function() {
      var self = this;

      return self.getDay() === 4;
    };

    def.$to_a = function() {
      var self = this;

      return [self.$sec(), self.$min(), self.$hour(), self.$day(), self.$month(), self.$year(), self.$wday(), self.$yday(), self.$isdst(), self.$zone()];
    };

    def.$to_f = function() {
      var self = this;

      return self.getTime() / 1000;
    };

    def.$to_i = function() {
      var self = this;

      return parseInt(self.getTime() / 1000);
    };

    $opal.defn(self, '$to_s', def.$inspect);

    def['$tuesday?'] = function() {
      var self = this;

      return self.getDay() === 2;
    };

    $opal.defn(self, '$utc?', def['$gmt?']);

    def.$utc_offset = function() {
      var self = this;

      return self.getTimezoneOffset() * -60;
    };

    def.$wday = function() {
      var self = this;

      return self.getDay();
    };

    def['$wednesday?'] = function() {
      var self = this;

      return self.getDay() === 3;
    };

    return (def.$year = function() {
      var self = this;

      return self.getFullYear();
    }, nil) && 'year';
  })(self, null);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$==', '$[]', '$upcase', '$const_set', '$new', '$unshift', '$each', '$define_struct_attribute', '$instance_eval', '$to_proc', '$raise', '$<<', '$members', '$define_method', '$instance_variable_get', '$instance_variable_set', '$include', '$each_with_index', '$class', '$===', '$>=', '$size', '$include?', '$to_sym', '$enum_for', '$hash', '$all?', '$length', '$map', '$+', '$name', '$join', '$inspect', '$each_pair']);
  return (function($base, $super) {
    function $Struct(){};
    var self = $Struct = $klass($base, $super, 'Struct', $Struct);

    var def = self._proto, $scope = self._scope, TMP_1, $a, TMP_8, TMP_10;

    $opal.defs(self, '$new', TMP_1 = function(name, args) {var $zuper = $slice.call(arguments, 0);
      var $a, $b, $c, TMP_2, $d, self = this, $iter = TMP_1._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_1._p = null;
      if (self['$==']((($a = $scope.Struct) == null ? $opal.cm('Struct') : $a))) {
        } else {
        return $opal.find_super_dispatcher(self, 'new', TMP_1, $iter, $Struct).apply(self, $zuper)
      };
      if (name['$[]'](0)['$=='](name['$[]'](0).$upcase())) {
        return (($a = $scope.Struct) == null ? $opal.cm('Struct') : $a).$const_set(name, ($a = self).$new.apply($a, [].concat(args)))
        } else {
        args.$unshift(name);
        return ($b = ($c = (($d = $scope.Class) == null ? $opal.cm('Class') : $d)).$new, $b._p = (TMP_2 = function(){var self = TMP_2._s || this, $a, $b, TMP_3, $c;

        ($a = ($b = args).$each, $a._p = (TMP_3 = function(arg){var self = TMP_3._s || this;
if (arg == null) arg = nil;
          return self.$define_struct_attribute(arg)}, TMP_3._s = self, TMP_3), $a).call($b);
          if (block !== false && block !== nil) {
            return ($a = ($c = self).$instance_eval, $a._p = block.$to_proc(), $a).call($c)
            } else {
            return nil
          };}, TMP_2._s = self, TMP_2), $b).call($c, self);
      };
    });

    $opal.defs(self, '$define_struct_attribute', function(name) {
      var $a, $b, TMP_4, $c, TMP_5, self = this;

      if (self['$==']((($a = $scope.Struct) == null ? $opal.cm('Struct') : $a))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "you cannot define attributes to the Struct class")};
      self.$members()['$<<'](name);
      ($a = ($b = self).$define_method, $a._p = (TMP_4 = function(){var self = TMP_4._s || this;

      return self.$instance_variable_get("@" + (name))}, TMP_4._s = self, TMP_4), $a).call($b, name);
      return ($a = ($c = self).$define_method, $a._p = (TMP_5 = function(value){var self = TMP_5._s || this;
if (value == null) value = nil;
      return self.$instance_variable_set("@" + (name), value)}, TMP_5._s = self, TMP_5), $a).call($c, "" + (name) + "=");
    });

    $opal.defs(self, '$members', function() {
      var $a, self = this;
      if (self.members == null) self.members = nil;

      if (self['$==']((($a = $scope.Struct) == null ? $opal.cm('Struct') : $a))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "the Struct class has no members")};
      return ((($a = self.members) !== false && $a !== nil) ? $a : self.members = []);
    });

    $opal.defs(self, '$inherited', function(klass) {
      var $a, $b, TMP_6, self = this, members = nil;
      if (self.members == null) self.members = nil;

      if (self['$==']((($a = $scope.Struct) == null ? $opal.cm('Struct') : $a))) {
        return nil};
      members = self.members;
      return ($a = ($b = klass).$instance_eval, $a._p = (TMP_6 = function(){var self = TMP_6._s || this;

      return self.members = members}, TMP_6._s = self, TMP_6), $a).call($b);
    });

    (function(self) {
      var $scope = self._scope, def = self._proto;

      return self._proto['$[]'] = self._proto.$new
    })(self.$singleton_class());

    self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

    def.$initialize = function(args) {
      var $a, $b, TMP_7, self = this;

      args = $slice.call(arguments, 0);
      return ($a = ($b = self.$members()).$each_with_index, $a._p = (TMP_7 = function(name, index){var self = TMP_7._s || this;
if (name == null) name = nil;if (index == null) index = nil;
      return self.$instance_variable_set("@" + (name), args['$[]'](index))}, TMP_7._s = self, TMP_7), $a).call($b);
    };

    def.$members = function() {
      var self = this;

      return self.$class().$members();
    };

    def['$[]'] = function(name) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Integer) == null ? $opal.cm('Integer') : $b)['$==='](name)) !== nil && (!$a._isBoolean || $a == true))) {
        if (name['$>='](self.$members().$size())) {
          self.$raise((($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a), "offset " + (name) + " too large for struct(size:" + (self.$members().$size()) + ")")};
        name = self.$members()['$[]'](name);
      } else if ((($a = self.$members()['$include?'](name.$to_sym())) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.NameError) == null ? $opal.cm('NameError') : $a), "no member '" + (name) + "' in struct")
      };
      return self.$instance_variable_get("@" + (name));
    };

    def['$[]='] = function(name, value) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Integer) == null ? $opal.cm('Integer') : $b)['$==='](name)) !== nil && (!$a._isBoolean || $a == true))) {
        if (name['$>='](self.$members().$size())) {
          self.$raise((($a = $scope.IndexError) == null ? $opal.cm('IndexError') : $a), "offset " + (name) + " too large for struct(size:" + (self.$members().$size()) + ")")};
        name = self.$members()['$[]'](name);
      } else if ((($a = self.$members()['$include?'](name.$to_sym())) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        self.$raise((($a = $scope.NameError) == null ? $opal.cm('NameError') : $a), "no member '" + (name) + "' in struct")
      };
      return self.$instance_variable_set("@" + (name), value);
    };

    def.$each = TMP_8 = function() {
      var $a, $b, TMP_9, self = this, $iter = TMP_8._p, $yield = $iter || nil;

      TMP_8._p = null;
      if (($yield !== nil)) {
        } else {
        return self.$enum_for("each")
      };
      ($a = ($b = self.$members()).$each, $a._p = (TMP_9 = function(name){var self = TMP_9._s || this, $a;
if (name == null) name = nil;
      return $a = $opal.$yield1($yield, self['$[]'](name)), $a === $breaker ? $a : $a}, TMP_9._s = self, TMP_9), $a).call($b);
      return self;
    };

    def.$each_pair = TMP_10 = function() {
      var $a, $b, TMP_11, self = this, $iter = TMP_10._p, $yield = $iter || nil;

      TMP_10._p = null;
      if (($yield !== nil)) {
        } else {
        return self.$enum_for("each_pair")
      };
      ($a = ($b = self.$members()).$each, $a._p = (TMP_11 = function(name){var self = TMP_11._s || this, $a;
if (name == null) name = nil;
      return $a = $opal.$yieldX($yield, [name, self['$[]'](name)]), $a === $breaker ? $a : $a}, TMP_11._s = self, TMP_11), $a).call($b);
      return self;
    };

    def['$eql?'] = function(other) {
      var $a, $b, $c, TMP_12, self = this;

      return ((($a = self.$hash()['$=='](other.$hash())) !== false && $a !== nil) ? $a : ($b = ($c = other.$each_with_index())['$all?'], $b._p = (TMP_12 = function(object, index){var self = TMP_12._s || this;
if (object == null) object = nil;if (index == null) index = nil;
      return self['$[]'](self.$members()['$[]'](index))['$=='](object)}, TMP_12._s = self, TMP_12), $b).call($c));
    };

    def.$length = function() {
      var self = this;

      return self.$members().$length();
    };

    $opal.defn(self, '$size', def.$length);

    def.$to_a = function() {
      var $a, $b, TMP_13, self = this;

      return ($a = ($b = self.$members()).$map, $a._p = (TMP_13 = function(name){var self = TMP_13._s || this;
if (name == null) name = nil;
      return self['$[]'](name)}, TMP_13._s = self, TMP_13), $a).call($b);
    };

    $opal.defn(self, '$values', def.$to_a);

    def.$inspect = function() {
      var $a, $b, TMP_14, self = this, result = nil;

      result = "#<struct ";
      if (self.$class()['$==']((($a = $scope.Struct) == null ? $opal.cm('Struct') : $a))) {
        result = result['$+']("" + (self.$class().$name()) + " ")};
      result = result['$+'](($a = ($b = self.$each_pair()).$map, $a._p = (TMP_14 = function(name, value){var self = TMP_14._s || this;
if (name == null) name = nil;if (value == null) value = nil;
      return "" + (name) + "=" + (value.$inspect())}, TMP_14._s = self, TMP_14), $a).call($b).$join(", "));
      result = result['$+'](">");
      return result;
    };

    return $opal.defn(self, '$to_s', def.$inspect);
  })(self, null)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, $b, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $module = $opal.module, $gvars = $opal.gvars;
  if ($gvars.stdout == null) $gvars.stdout = nil;
  if ($gvars.stderr == null) $gvars.stderr = nil;

  $opal.add_stubs(['$write', '$join', '$map', '$String', '$getbyte', '$getc', '$raise', '$new', '$to_s', '$extend']);
  (function($base, $super) {
    function $IO(){};
    var self = $IO = $klass($base, $super, 'IO', $IO);

    var def = self._proto, $scope = self._scope;

    $opal.cdecl($scope, 'SEEK_SET', 0);

    $opal.cdecl($scope, 'SEEK_CUR', 1);

    $opal.cdecl($scope, 'SEEK_END', 2);

    (function($base) {
      var self = $module($base, 'Writable');

      var def = self._proto, $scope = self._scope;

      def['$<<'] = function(string) {
        var self = this;

        self.$write(string);
        return self;
      };

      def.$print = function(args) {
        var $a, $b, TMP_1, self = this;
        if ($gvars[","] == null) $gvars[","] = nil;

        args = $slice.call(arguments, 0);
        return self.$write(($a = ($b = args).$map, $a._p = (TMP_1 = function(arg){var self = TMP_1._s || this;
if (arg == null) arg = nil;
        return self.$String(arg)}, TMP_1._s = self, TMP_1), $a).call($b).$join($gvars[","]));
      };

      def.$puts = function(args) {
        var $a, $b, TMP_2, self = this;
        if ($gvars["/"] == null) $gvars["/"] = nil;

        args = $slice.call(arguments, 0);
        return self.$write(($a = ($b = args).$map, $a._p = (TMP_2 = function(arg){var self = TMP_2._s || this;
if (arg == null) arg = nil;
        return self.$String(arg)}, TMP_2._s = self, TMP_2), $a).call($b).$join($gvars["/"]));
      };
            ;$opal.donate(self, ["$<<", "$print", "$puts"]);
    })(self);

    return (function($base) {
      var self = $module($base, 'Readable');

      var def = self._proto, $scope = self._scope;

      def.$readbyte = function() {
        var self = this;

        return self.$getbyte();
      };

      def.$readchar = function() {
        var self = this;

        return self.$getc();
      };

      def.$readline = function(sep) {
        var $a, self = this;
        if ($gvars["/"] == null) $gvars["/"] = nil;

        if (sep == null) {
          sep = $gvars["/"]
        }
        return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
      };

      def.$readpartial = function(integer, outbuf) {
        var $a, self = this;

        if (outbuf == null) {
          outbuf = nil
        }
        return self.$raise((($a = $scope.NotImplementedError) == null ? $opal.cm('NotImplementedError') : $a));
      };
            ;$opal.donate(self, ["$readbyte", "$readchar", "$readline", "$readpartial"]);
    })(self);
  })(self, null);
  $opal.cdecl($scope, 'STDERR', $gvars.stderr = (($a = $scope.IO) == null ? $opal.cm('IO') : $a).$new());
  $opal.cdecl($scope, 'STDIN', $gvars.stdin = (($a = $scope.IO) == null ? $opal.cm('IO') : $a).$new());
  $opal.cdecl($scope, 'STDOUT', $gvars.stdout = (($a = $scope.IO) == null ? $opal.cm('IO') : $a).$new());
  $opal.defs($gvars.stdout, '$write', function(string) {
    var self = this;

    console.log(string.$to_s());;
    return nil;
  });
  $opal.defs($gvars.stderr, '$write', function(string) {
    var self = this;

    console.warn(string.$to_s());;
    return nil;
  });
  $gvars.stdout.$extend((($a = ((($b = $scope.IO) == null ? $opal.cm('IO') : $b))._scope).Writable == null ? $a.cm('Writable') : $a.Writable));
  return $gvars.stderr.$extend((($a = ((($b = $scope.IO) == null ? $opal.cm('IO') : $b))._scope).Writable == null ? $a.cm('Writable') : $a.Writable));
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice;

  $opal.add_stubs(['$include']);
  $opal.defs(self, '$to_s', function() {
    var self = this;

    return "main";
  });
  return ($opal.defs(self, '$include', function(mod) {
    var $a, self = this;

    return (($a = $scope.Object) == null ? $opal.cm('Object') : $a).$include(mod);
  }), nil) && 'include';
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $gvars = $opal.gvars, $hash2 = $opal.hash2;

  $opal.add_stubs(['$new']);
  $gvars["&"] = $gvars["~"] = $gvars["`"] = $gvars["'"] = nil;
  $gvars[":"] = [];
  $gvars["\""] = [];
  $gvars["/"] = "\n";
  $gvars[","] = nil;
  $opal.cdecl($scope, 'ARGV', []);
  $opal.cdecl($scope, 'ARGF', (($a = $scope.Object) == null ? $opal.cm('Object') : $a).$new());
  $opal.cdecl($scope, 'ENV', $hash2([], {}));
  $gvars.VERBOSE = false;
  $gvars.DEBUG = false;
  $gvars.SAFE = 0;
  $opal.cdecl($scope, 'RUBY_PLATFORM', "opal");
  $opal.cdecl($scope, 'RUBY_ENGINE', "opal");
  $opal.cdecl($scope, 'RUBY_VERSION', "2.1.1");
  $opal.cdecl($scope, 'RUBY_ENGINE_VERSION', "0.6.1");
  return $opal.cdecl($scope, 'RUBY_RELEASE_DATE', "2014-04-15");
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice;

  $opal.add_stubs([]);
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  return true;
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $range = $opal.range, $hash2 = $opal.hash2, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$try_convert', '$native?', '$respond_to?', '$to_n', '$raise', '$inspect', '$Native', '$end_with?', '$define_method', '$[]', '$convert', '$call', '$to_proc', '$new', '$each', '$native_reader', '$native_writer', '$extend', '$to_a', '$to_ary', '$include', '$method_missing', '$bind', '$instance_method', '$[]=', '$slice', '$-', '$length', '$enum_for', '$===', '$>=', '$<<', '$==', '$instance_variable_set', '$members', '$each_with_index', '$each_pair', '$name']);
  (function($base) {
    var self = $module($base, 'Native');

    var def = self._proto, $scope = self._scope, TMP_1;

    $opal.defs(self, '$is_a?', function(object, klass) {
      var self = this;

      
      try {
        return object instanceof self.$try_convert(klass);
      }
      catch (e) {
        return false;
      }
    ;
    });

    $opal.defs(self, '$try_convert', function(value) {
      var self = this;

      
      if (self['$native?'](value)) {
        return value;
      }
      else if (value['$respond_to?']("to_n")) {
        return value.$to_n();
      }
      else {
        return nil;
      }
    ;
    });

    $opal.defs(self, '$convert', function(value) {
      var $a, self = this;

      
      if (self['$native?'](value)) {
        return value;
      }
      else if (value['$respond_to?']("to_n")) {
        return value.$to_n();
      }
      else {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "" + (value.$inspect()) + " isn't native");
      }
    ;
    });

    $opal.defs(self, '$call', TMP_1 = function(obj, key, args) {
      var self = this, $iter = TMP_1._p, block = $iter || nil;

      args = $slice.call(arguments, 2);
      TMP_1._p = null;
      
      var prop = obj[key];

      if (prop instanceof Function) {
        var converted = new Array(args.length);

        for (var i = 0, length = args.length; i < length; i++) {
          var item = args[i],
              conv = self.$try_convert(item);

          converted[i] = conv === nil ? item : conv;
        }

        if (block !== nil) {
          converted.push(block);
        }

        return self.$Native(prop.apply(obj, converted));
      }
      else {
        return self.$Native(prop);
      }
    ;
    });

    (function($base) {
      var self = $module($base, 'Helpers');

      var def = self._proto, $scope = self._scope;

      def.$alias_native = function(new$, old, options) {
        var $a, $b, TMP_2, $c, TMP_3, $d, TMP_4, self = this, as = nil;

        if (old == null) {
          old = new$
        }
        if (options == null) {
          options = $hash2([], {})
        }
        if ((($a = old['$end_with?']("=")) !== nil && (!$a._isBoolean || $a == true))) {
          return ($a = ($b = self).$define_method, $a._p = (TMP_2 = function(value){var self = TMP_2._s || this, $a;
            if (self["native"] == null) self["native"] = nil;
if (value == null) value = nil;
          self["native"][old['$[]']($range(0, -2, false))] = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(value);
            return value;}, TMP_2._s = self, TMP_2), $a).call($b, new$)
        } else if ((($a = as = options['$[]']("as")) !== nil && (!$a._isBoolean || $a == true))) {
          return ($a = ($c = self).$define_method, $a._p = (TMP_3 = function(args){var self = TMP_3._s || this, block, $a, $b, $c, $d;
            if (self["native"] == null) self["native"] = nil;
args = $slice.call(arguments, 0);
            block = TMP_3._p || nil, TMP_3._p = null;
          if ((($a = value = ($b = ($c = (($d = $scope.Native) == null ? $opal.cm('Native') : $d)).$call, $b._p = block.$to_proc(), $b).apply($c, [self["native"], old].concat(args))) !== nil && (!$a._isBoolean || $a == true))) {
              return as.$new(value.$to_n())
              } else {
              return nil
            }}, TMP_3._s = self, TMP_3), $a).call($c, new$)
          } else {
          return ($a = ($d = self).$define_method, $a._p = (TMP_4 = function(args){var self = TMP_4._s || this, block, $a, $b, $c;
            if (self["native"] == null) self["native"] = nil;
args = $slice.call(arguments, 0);
            block = TMP_4._p || nil, TMP_4._p = null;
          return ($a = ($b = (($c = $scope.Native) == null ? $opal.cm('Native') : $c)).$call, $a._p = block.$to_proc(), $a).apply($b, [self["native"], old].concat(args))}, TMP_4._s = self, TMP_4), $a).call($d, new$)
        };
      };

      def.$native_reader = function(names) {
        var $a, $b, TMP_5, self = this;

        names = $slice.call(arguments, 0);
        return ($a = ($b = names).$each, $a._p = (TMP_5 = function(name){var self = TMP_5._s || this, $a, $b, TMP_6;
if (name == null) name = nil;
        return ($a = ($b = self).$define_method, $a._p = (TMP_6 = function(){var self = TMP_6._s || this;
            if (self["native"] == null) self["native"] = nil;

          return self.$Native(self["native"][name])}, TMP_6._s = self, TMP_6), $a).call($b, name)}, TMP_5._s = self, TMP_5), $a).call($b);
      };

      def.$native_writer = function(names) {
        var $a, $b, TMP_7, self = this;

        names = $slice.call(arguments, 0);
        return ($a = ($b = names).$each, $a._p = (TMP_7 = function(name){var self = TMP_7._s || this, $a, $b, TMP_8;
if (name == null) name = nil;
        return ($a = ($b = self).$define_method, $a._p = (TMP_8 = function(value){var self = TMP_8._s || this;
            if (self["native"] == null) self["native"] = nil;
if (value == null) value = nil;
          return self.$Native(self["native"][name] = value)}, TMP_8._s = self, TMP_8), $a).call($b, "" + (name) + "=")}, TMP_7._s = self, TMP_7), $a).call($b);
      };

      def.$native_accessor = function(names) {
        var $a, $b, self = this;

        names = $slice.call(arguments, 0);
        ($a = self).$native_reader.apply($a, [].concat(names));
        return ($b = self).$native_writer.apply($b, [].concat(names));
      };
            ;$opal.donate(self, ["$alias_native", "$native_reader", "$native_writer", "$native_accessor"]);
    })(self);

    $opal.defs(self, '$included', function(klass) {
      var $a, self = this;

      return klass.$extend((($a = $scope.Helpers) == null ? $opal.cm('Helpers') : $a));
    });

    def.$initialize = function(native$) {
      var $a, $b, self = this;

      if ((($a = (($b = $scope.Kernel) == null ? $opal.cm('Kernel') : $b)['$native?'](native$)) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        (($a = $scope.Kernel) == null ? $opal.cm('Kernel') : $a).$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "" + (native$.$inspect()) + " isn't native")
      };
      return self["native"] = native$;
    };

    def.$to_n = function() {
      var self = this;
      if (self["native"] == null) self["native"] = nil;

      return self["native"];
    };
        ;$opal.donate(self, ["$initialize", "$to_n"]);
  })(self);
  (function($base) {
    var self = $module($base, 'Kernel');

    var def = self._proto, $scope = self._scope, TMP_9;

    def['$native?'] = function(value) {
      var self = this;

      return value == null || !value._klass;
    };

    def.$Native = function(obj) {
      var $a, $b, self = this;

      if ((($a = obj == null) !== nil && (!$a._isBoolean || $a == true))) {
        return nil
      } else if ((($a = self['$native?'](obj)) !== nil && (!$a._isBoolean || $a == true))) {
        return (($a = ((($b = $scope.Native) == null ? $opal.cm('Native') : $b))._scope).Object == null ? $a.cm('Object') : $a.Object).$new(obj)
        } else {
        return obj
      };
    };

    def.$Array = TMP_9 = function(object, args) {
      var $a, $b, $c, $d, self = this, $iter = TMP_9._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_9._p = null;
      
      if (object == null || object === nil) {
        return [];
      }
      else if (self['$native?'](object)) {
        return ($a = ($b = (($c = ((($d = $scope.Native) == null ? $opal.cm('Native') : $d))._scope).Array == null ? $c.cm('Array') : $c.Array)).$new, $a._p = block.$to_proc(), $a).apply($b, [object].concat(args)).$to_a();
      }
      else if (object['$respond_to?']("to_ary")) {
        return object.$to_ary();
      }
      else if (object['$respond_to?']("to_a")) {
        return object.$to_a();
      }
      else {
        return [object];
      }
    ;
    };
        ;$opal.donate(self, ["$native?", "$Native", "$Array"]);
  })(self);
  (function($base, $super) {
    function $Object(){};
    var self = $Object = $klass($base, $super, 'Object', $Object);

    var def = self._proto, $scope = self._scope, $a, TMP_10, TMP_11, TMP_12;

    def["native"] = nil;
    self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

    $opal.defn(self, '$==', function(other) {
      var $a, self = this;

      return self["native"] === (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$try_convert(other);
    });

    $opal.defn(self, '$has_key?', function(name) {
      var self = this;

      return $opal.hasOwnProperty.call(self["native"], name);
    });

    $opal.defn(self, '$key?', def['$has_key?']);

    $opal.defn(self, '$include?', def['$has_key?']);

    $opal.defn(self, '$member?', def['$has_key?']);

    $opal.defn(self, '$each', TMP_10 = function(args) {
      var $a, self = this, $iter = TMP_10._p, $yield = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_10._p = null;
      if (($yield !== nil)) {
        
        for (var key in self["native"]) {
          ((($a = $opal.$yieldX($yield, [key, self["native"][key]])) === $breaker) ? $breaker.$v : $a)
        }
      ;
        return self;
        } else {
        return ($a = self).$method_missing.apply($a, ["each"].concat(args))
      };
    });

    $opal.defn(self, '$[]', function(key) {
      var $a, self = this;

      
      var prop = self["native"][key];

      if (prop instanceof Function) {
        return prop;
      }
      else {
        return (($a = $opal.Object._scope.Native) == null ? $opal.cm('Native') : $a).$call(self["native"], key)
      }
    ;
    });

    $opal.defn(self, '$[]=', function(key, value) {
      var $a, self = this, native$ = nil;

      native$ = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$try_convert(value);
      if ((($a = native$ === nil) !== nil && (!$a._isBoolean || $a == true))) {
        return self["native"][key] = value;
        } else {
        return self["native"][key] = native$;
      };
    });

    $opal.defn(self, '$merge!', function(other) {
      var $a, self = this;

      
      var other = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(other);

      for (var prop in other) {
        self["native"][prop] = other[prop];
      }
    ;
      return self;
    });

    $opal.defn(self, '$respond_to?', function(name, include_all) {
      var $a, self = this;

      if (include_all == null) {
        include_all = false
      }
      return (($a = $scope.Kernel) == null ? $opal.cm('Kernel') : $a).$instance_method("respond_to?").$bind(self).$call(name, include_all);
    });

    $opal.defn(self, '$respond_to_missing?', function(name) {
      var self = this;

      return $opal.hasOwnProperty.call(self["native"], name);
    });

    $opal.defn(self, '$method_missing', TMP_11 = function(mid, args) {
      var $a, $b, $c, self = this, $iter = TMP_11._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_11._p = null;
      
      if (mid.charAt(mid.length - 1) === '=') {
        return self['$[]='](mid.$slice(0, mid.$length()['$-'](1)), args['$[]'](0));
      }
      else {
        return ($a = ($b = (($c = $opal.Object._scope.Native) == null ? $opal.cm('Native') : $c)).$call, $a._p = block.$to_proc(), $a).apply($b, [self["native"], mid].concat(args));
      }
    ;
    });

    $opal.defn(self, '$nil?', function() {
      var self = this;

      return false;
    });

    $opal.defn(self, '$is_a?', function(klass) {
      var self = this;

      return $opal.is_a(self, klass);
    });

    $opal.defn(self, '$kind_of?', def['$is_a?']);

    $opal.defn(self, '$instance_of?', function(klass) {
      var self = this;

      return self._klass === klass;
    });

    $opal.defn(self, '$class', function() {
      var self = this;

      return self._klass;
    });

    $opal.defn(self, '$to_a', TMP_12 = function(options) {
      var $a, $b, $c, $d, self = this, $iter = TMP_12._p, block = $iter || nil;

      if (options == null) {
        options = $hash2([], {})
      }
      TMP_12._p = null;
      return ($a = ($b = (($c = ((($d = $scope.Native) == null ? $opal.cm('Native') : $d))._scope).Array == null ? $c.cm('Array') : $c.Array)).$new, $a._p = block.$to_proc(), $a).call($b, self["native"], options).$to_a();
    });

    return ($opal.defn(self, '$inspect', function() {
      var self = this;

      return "#<Native:" + (String(self["native"])) + ">";
    }), nil) && 'inspect';
  })((($a = $scope.Native) == null ? $opal.cm('Native') : $a), (($a = $scope.BasicObject) == null ? $opal.cm('BasicObject') : $a));
  (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self._proto, $scope = self._scope, $a, TMP_13, TMP_14;

    def.named = def["native"] = def.get = def.block = def.set = def.length = nil;
    self.$include((($a = $scope.Native) == null ? $opal.cm('Native') : $a));

    self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

    def.$initialize = TMP_13 = function(native$, options) {
      var $a, self = this, $iter = TMP_13._p, block = $iter || nil;

      if (options == null) {
        options = $hash2([], {})
      }
      TMP_13._p = null;
      $opal.find_super_dispatcher(self, 'initialize', TMP_13, null).apply(self, [native$]);
      self.get = ((($a = options['$[]']("get")) !== false && $a !== nil) ? $a : options['$[]']("access"));
      self.named = options['$[]']("named");
      self.set = ((($a = options['$[]']("set")) !== false && $a !== nil) ? $a : options['$[]']("access"));
      self.length = ((($a = options['$[]']("length")) !== false && $a !== nil) ? $a : "length");
      self.block = block;
      if ((($a = self.$length() == null) !== nil && (!$a._isBoolean || $a == true))) {
        return self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "no length found on the array-like object")
        } else {
        return nil
      };
    };

    def.$each = TMP_14 = function() {
      var self = this, $iter = TMP_14._p, block = $iter || nil;

      TMP_14._p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each")
      };
      
      for (var i = 0, length = self.$length(); i < length; i++) {
        var value = $opal.$yield1(block, self['$[]'](i));

        if (value === $breaker) {
          return $breaker.$v;
        }
      }
    ;
      return self;
    };

    def['$[]'] = function(index) {
      var $a, self = this, result = nil, $case = nil;

      result = (function() {$case = index;if ((($a = $scope.String) == null ? $opal.cm('String') : $a)['$===']($case) || (($a = $scope.Symbol) == null ? $opal.cm('Symbol') : $a)['$===']($case)) {if ((($a = self.named) !== nil && (!$a._isBoolean || $a == true))) {
        return self["native"][self.named](index);
        } else {
        return self["native"][index];
      }}else if ((($a = $scope.Integer) == null ? $opal.cm('Integer') : $a)['$===']($case)) {if ((($a = self.get) !== nil && (!$a._isBoolean || $a == true))) {
        return self["native"][self.get](index);
        } else {
        return self["native"][index];
      }}else { return nil }})();
      if (result !== false && result !== nil) {
        if ((($a = self.block) !== nil && (!$a._isBoolean || $a == true))) {
          return self.block.$call(result)
          } else {
          return self.$Native(result)
        }
        } else {
        return nil
      };
    };

    def['$[]='] = function(index, value) {
      var $a, self = this;

      if ((($a = self.set) !== nil && (!$a._isBoolean || $a == true))) {
        return self["native"][self.set](index, (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(value));
        } else {
        return self["native"][index] = (($a = $scope.Native) == null ? $opal.cm('Native') : $a).$convert(value);
      };
    };

    def.$last = function(count) {
      var $a, self = this, index = nil, result = nil;

      if (count == null) {
        count = nil
      }
      if (count !== false && count !== nil) {
        index = self.$length()['$-'](1);
        result = [];
        while (index['$>='](0)) {
        result['$<<'](self['$[]'](index));
        index = index['$-'](1);};
        return result;
        } else {
        return self['$[]'](self.$length()['$-'](1))
      };
    };

    def.$length = function() {
      var self = this;

      return self["native"][self.length];
    };

    $opal.defn(self, '$to_ary', def.$to_a);

    return (def.$inspect = function() {
      var self = this;

      return self.$to_a().$inspect();
    }, nil) && 'inspect';
  })((($a = $scope.Native) == null ? $opal.cm('Native') : $a), null);
  (function($base, $super) {
    function $Numeric(){};
    var self = $Numeric = $klass($base, $super, 'Numeric', $Numeric);

    var def = self._proto, $scope = self._scope;

    return (def.$to_n = function() {
      var self = this;

      return self.valueOf();
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Proc(){};
    var self = $Proc = $klass($base, $super, 'Proc', $Proc);

    var def = self._proto, $scope = self._scope;

    return (def.$to_n = function() {
      var self = this;

      return self;
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self._proto, $scope = self._scope;

    return (def.$to_n = function() {
      var self = this;

      return self.valueOf();
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Regexp(){};
    var self = $Regexp = $klass($base, $super, 'Regexp', $Regexp);

    var def = self._proto, $scope = self._scope;

    return (def.$to_n = function() {
      var self = this;

      return self.valueOf();
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $MatchData(){};
    var self = $MatchData = $klass($base, $super, 'MatchData', $MatchData);

    var def = self._proto, $scope = self._scope;

    def.matches = nil;
    return (def.$to_n = function() {
      var self = this;

      return self.matches;
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Struct(){};
    var self = $Struct = $klass($base, $super, 'Struct', $Struct);

    var def = self._proto, $scope = self._scope;

    def.$initialize = function(args) {
      var $a, $b, TMP_15, $c, TMP_16, self = this, object = nil;

      args = $slice.call(arguments, 0);
      if ((($a = (($b = args.$length()['$=='](1)) ? self['$native?'](args['$[]'](0)) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        object = args['$[]'](0);
        return ($a = ($b = self.$members()).$each, $a._p = (TMP_15 = function(name){var self = TMP_15._s || this;
if (name == null) name = nil;
        return self.$instance_variable_set("@" + (name), self.$Native(object[name]))}, TMP_15._s = self, TMP_15), $a).call($b);
        } else {
        return ($a = ($c = self.$members()).$each_with_index, $a._p = (TMP_16 = function(name, index){var self = TMP_16._s || this;
if (name == null) name = nil;if (index == null) index = nil;
        return self.$instance_variable_set("@" + (name), args['$[]'](index))}, TMP_16._s = self, TMP_16), $a).call($c)
      };
    };

    return (def.$to_n = function() {
      var $a, $b, TMP_17, self = this, result = nil;

      result = {};
      ($a = ($b = self).$each_pair, $a._p = (TMP_17 = function(name, value){var self = TMP_17._s || this;
if (name == null) name = nil;if (value == null) value = nil;
      return result[name] = value.$to_n();}, TMP_17._s = self, TMP_17), $a).call($b);
      return result;
    }, nil) && 'to_n';
  })(self, null);
  (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self._proto, $scope = self._scope;

    return (def.$to_n = function() {
      var self = this;

      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        var obj = self[i];

        if ((obj)['$respond_to?']("to_n")) {
          result.push((obj).$to_n());
        }
        else {
          result.push(obj);
        }
      }

      return result;
    ;
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Boolean(){};
    var self = $Boolean = $klass($base, $super, 'Boolean', $Boolean);

    var def = self._proto, $scope = self._scope;

    return (def.$to_n = function() {
      var self = this;

      return self.valueOf();
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Time(){};
    var self = $Time = $klass($base, $super, 'Time', $Time);

    var def = self._proto, $scope = self._scope;

    return (def.$to_n = function() {
      var self = this;

      return self;
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $NilClass(){};
    var self = $NilClass = $klass($base, $super, 'NilClass', $NilClass);

    var def = self._proto, $scope = self._scope;

    return (def.$to_n = function() {
      var self = this;

      return null;
    }, nil) && 'to_n'
  })(self, null);
  (function($base, $super) {
    function $Hash(){};
    var self = $Hash = $klass($base, $super, 'Hash', $Hash);

    var def = self._proto, $scope = self._scope, TMP_18;

    def.$initialize = TMP_18 = function(defaults) {
      var $a, self = this, $iter = TMP_18._p, block = $iter || nil;

      TMP_18._p = null;
      
      if (defaults != null) {
        if (defaults.constructor === Object) {
          var map  = self.map,
              keys = self.keys;

          for (var key in defaults) {
            var value = defaults[key];

            if (value && value.constructor === Object) {
              map[key] = (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a).$new(value);
            }
            else {
              map[key] = self.$Native(defaults[key]);
            }

            keys.push(key);
          }
        }
        else {
          self.none = defaults;
        }
      }
      else if (block !== nil) {
        self.proc = block;
      }

      return self;
    
    };

    return (def.$to_n = function() {
      var self = this;

      
      var result = {},
          keys   = self.keys,
          map    = self.map,
          bucket,
          value;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i],
            obj = map[key];

        if ((obj)['$respond_to?']("to_n")) {
          result[key] = (obj).$to_n();
        }
        else {
          result[key] = obj;
        }
      }

      return result;
    ;
    }, nil) && 'to_n';
  })(self, null);
  (function($base, $super) {
    function $Module(){};
    var self = $Module = $klass($base, $super, 'Module', $Module);

    var def = self._proto, $scope = self._scope;

    return (def.$native_module = function() {
      var self = this;

      return Opal.global[self.$name()] = self;
    }, nil) && 'native_module'
  })(self, null);
  (function($base, $super) {
    function $Class(){};
    var self = $Class = $klass($base, $super, 'Class', $Class);

    var def = self._proto, $scope = self._scope;

    def.$native_alias = function(jsid, mid) {
      var self = this;

      return self._proto[jsid] = self._proto['$' + mid];
    };

    return $opal.defn(self, '$native_class', def.$native_module);
  })(self, null);
  return $gvars.$ = $gvars.global = self.$Native(Opal.global);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$attr_reader', '$expose', '$alias_native', '$[]=', '$nil?', '$is_a?', '$to_n', '$has_key?', '$delete', '$call', '$gsub', '$upcase', '$[]', '$compact', '$map', '$respond_to?', '$<<', '$Native', '$new']);
  ;
  
  var root = $opal.global, dom_class;

  if (root.jQuery) {
    dom_class = jQuery
  }
  else if (root.Zepto) {
    dom_class = Zepto.zepto.Z;
  }
  else {
    throw new Error("jQuery must be included before opal-jquery");
  }

  return (function($base, $super) {
    function $Element(){};
    var self = $Element = $klass($base, $super, 'Element', $Element);

    var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2, TMP_5, TMP_6;

    self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

    $opal.defs(self, '$find', function(selector) {
      var self = this;

      return $(selector);
    });

    $opal.defs(self, '$[]', function(selector) {
      var self = this;

      return $(selector);
    });

    $opal.defs(self, '$id', function(id) {
      var self = this;

      
      var el = document.getElementById(id);

      if (!el) {
        return nil;
      }

      return $(el);
    
    });

    $opal.defs(self, '$new', function(tag) {
      var self = this;

      if (tag == null) {
        tag = "div"
      }
      return $(document.createElement(tag));
    });

    $opal.defs(self, '$parse', function(str) {
      var self = this;

      return $(str);
    });

    $opal.defs(self, '$expose', function(methods) {
      var self = this;

      methods = $slice.call(arguments, 0);
      
      for (var i = 0, length = methods.length, method; i < length; i++) {
        method = methods[i];
        self._proto['$' + method] = self._proto[method];
      }

      return nil;
    
    });

    self.$attr_reader("selector");

    self.$expose("after", "before", "parent", "parents", "prepend", "prev", "remove");

    self.$expose("hide", "show", "toggle", "children", "blur", "closest", "detach");

    self.$expose("focus", "find", "next", "siblings", "text", "trigger", "append");

    self.$expose("height", "width", "serialize", "is", "filter", "last", "first");

    self.$expose("wrap", "stop", "clone", "empty");

    self.$expose("get", "attr", "prop");

    $opal.defn(self, '$succ', def.$next);

    $opal.defn(self, '$<<', def.$append);

    self.$alias_native("[]=", "attr");

    self.$alias_native("add_class", "addClass");

    self.$alias_native("append_to", "appendTo");

    self.$alias_native("has_class?", "hasClass");

    self.$alias_native("html=", "html");

    self.$alias_native("remove_attr", "removeAttr");

    self.$alias_native("remove_class", "removeClass");

    self.$alias_native("text=", "text");

    self.$alias_native("toggle_class", "toggleClass");

    self.$alias_native("value=", "val");

    self.$alias_native("scroll_left=", "scrollLeft");

    self.$alias_native("scroll_left", "scrollLeft");

    self.$alias_native("remove_attribute", "removeAttr");

    self.$alias_native("slide_down", "slideDown");

    self.$alias_native("slide_up", "slideUp");

    self.$alias_native("slide_toggle", "slideToggle");

    self.$alias_native("fade_toggle", "fadeToggle");

    def.$to_n = function() {
      var self = this;

      return self;
    };

    def['$[]'] = function(name) {
      var self = this;

      return self.attr(name) || "";
    };

    def.$add_attribute = function(name) {
      var self = this;

      return self['$[]='](name, "");
    };

    def['$has_attribute?'] = function(name) {
      var self = this;

      return !!self.attr(name);
    };

    def.$append_to_body = function() {
      var self = this;

      return self.appendTo(document.body);
    };

    def.$append_to_head = function() {
      var self = this;

      return self.appendTo(document.head);
    };

    def.$at = function(index) {
      var self = this;

      
      var length = self.length;

      if (index < 0) {
        index += length;
      }

      if (index < 0 || index >= length) {
        return nil;
      }

      return $(self[index]);
    
    };

    def.$class_name = function() {
      var self = this;

      
      var first = self[0];
      return (first && first.className) || "";
    
    };

    def['$class_name='] = function(name) {
      var self = this;

      
      for (var i = 0, length = self.length; i < length; i++) {
        self[i].className = name;
      }
    
      return self;
    };

    def.$css = function(name, value) {
      var $a, $b, $c, self = this;

      if (value == null) {
        value = nil
      }
      if ((($a = ($b = value['$nil?'](), $b !== false && $b !== nil ?name['$is_a?']((($c = $scope.String) == null ? $opal.cm('String') : $c)) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return self.css(name)
      } else if ((($a = name['$is_a?']((($b = $scope.Hash) == null ? $opal.cm('Hash') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        self.css(name.$to_n());
        } else {
        self.css(name, value);
      };
      return self;
    };

    def.$animate = TMP_1 = function(params) {
      var $a, self = this, $iter = TMP_1._p, block = $iter || nil, speed = nil;

      TMP_1._p = null;
      speed = (function() {if ((($a = params['$has_key?']("speed")) !== nil && (!$a._isBoolean || $a == true))) {
        return params.$delete("speed")
        } else {
        return 400
      }; return nil; })();
      
      self.animate(params.$to_n(), speed, function() {
        (function() {if ((block !== nil)) {
        return block.$call()
        } else {
        return nil
      }; return nil; })()
      })
    ;
    };

    def.$data = function(args) {
      var self = this;

      args = $slice.call(arguments, 0);
      
      var result = self.data.apply(self, args);
      return result == null ? nil : result;
    
    };

    def.$effect = TMP_2 = function(name, args) {
      var $a, $b, TMP_3, $c, TMP_4, self = this, $iter = TMP_2._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_2._p = null;
      name = ($a = ($b = name).$gsub, $a._p = (TMP_3 = function(match){var self = TMP_3._s || this;
if (match == null) match = nil;
      return match['$[]'](1).$upcase()}, TMP_3._s = self, TMP_3), $a).call($b, /_\w/);
      args = ($a = ($c = args).$map, $a._p = (TMP_4 = function(a){var self = TMP_4._s || this, $a;
if (a == null) a = nil;
      if ((($a = a['$respond_to?']("to_n")) !== nil && (!$a._isBoolean || $a == true))) {
          return a.$to_n()
          } else {
          return nil
        }}, TMP_4._s = self, TMP_4), $a).call($c).$compact();
      args['$<<'](function() { (function() {if ((block !== nil)) {
        return block.$call()
        } else {
        return nil
      }; return nil; })() });
      return self[name].apply(self, args);
    };

    def['$visible?'] = function() {
      var self = this;

      return self.is(':visible');
    };

    def.$offset = function() {
      var self = this;

      return self.$Native(self.offset());
    };

    def.$each = TMP_5 = function() {
      var self = this, $iter = TMP_5._p, $yield = $iter || nil;

      TMP_5._p = null;
      for (var i = 0, length = self.length; i < length; i++) {
      if ($opal.$yield1($yield, $(self[i])) === $breaker) return $breaker.$v;
      };
      return self;
    };

    def.$first = function() {
      var self = this;

      return self.length ? self.first() : nil;
    };

    def.$html = function(content) {
      var self = this;

      
      if (content != null) {
        return self.html(content);
      }

      return self.html() || '';
    
    };

    def.$id = function() {
      var self = this;

      
      var first = self[0];
      return (first && first.id) || "";
    
    };

    def['$id='] = function(id) {
      var self = this;

      
      var first = self[0];

      if (first) {
        first.id = id;
      }

      return self;
    
    };

    def.$tag_name = function() {
      var self = this;

      return self.length > 0 ? self[0].tagName.toLowerCase() : nil;
    };

    def.$inspect = function() {
      var self = this;

      
      var val, el, str, result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        el  = self[i];
        str = "<" + el.tagName.toLowerCase();

        if (val = el.id) str += (' id="' + val + '"');
        if (val = el.className) str += (' class="' + val + '"');

        result.push(str + '>');
      }

      return '#<Element [' + result.join(', ') + ']>';
    
    };

    def.$length = function() {
      var self = this;

      return self.length;
    };

    def['$any?'] = function() {
      var self = this;

      return self.length > 0;
    };

    def['$empty?'] = function() {
      var self = this;

      return self.length === 0;
    };

    $opal.defn(self, '$empty?', def['$none?']);

    def.$on = TMP_6 = function(name, sel) {
      var $a, self = this, $iter = TMP_6._p, block = $iter || nil;

      if (sel == null) {
        sel = nil
      }
      TMP_6._p = null;
      
      var wrapper = function(evt) {
        if (evt.preventDefault) {
          evt = (($a = $scope.Event) == null ? $opal.cm('Event') : $a).$new(evt);
        }

        return block.apply(null, arguments);
      };

      block._jq_wrap = wrapper;

      if (sel == nil) {
        self.on(name, wrapper);
      }
      else {
        self.on(name, sel, wrapper);
      }
    ;
      return block;
    };

    def.$off = function(name, sel, block) {
      var self = this;

      if (block == null) {
        block = nil
      }
      
      if (sel == null) {
        return self.off(name);
      }
      else if (block === nil) {
        return self.off(name, sel._jq_wrap);
      }
      else {
        return self.off(name, sel, block._jq_wrap);
      }
    
    };

    $opal.defn(self, '$size', def.$length);

    return (def.$value = function() {
      var self = this;

      return self.val() || "";
    }, nil) && 'value';
  })(self, dom_class);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $gvars = $opal.gvars;

  $opal.add_stubs(['$find']);
  ;
  $opal.cdecl($scope, 'Window', (($a = $scope.Element) == null ? $opal.cm('Element') : $a).$find(window));
  return $gvars.window = (($a = $scope.Window) == null ? $opal.cm('Window') : $a);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $gvars = $opal.gvars;

  $opal.add_stubs(['$find']);
  ;
  $opal.cdecl($scope, 'Document', (($a = $scope.Element) == null ? $opal.cm('Element') : $a).$find(document));
  (function(self) {
    var $scope = self._scope, def = self._proto;

    self._proto['$ready?'] = TMP_1 = function() {
      var self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      if (block !== false && block !== nil) {
        return $(block);
        } else {
        return nil
      };
    };
    self._proto.$title = function() {
      var self = this;

      return document.title;
    };
    self._proto['$title='] = function(title) {
      var self = this;

      return document.title = title;
    };
    self._proto.$head = function() {
      var $a, self = this;

      return (($a = $scope.Element) == null ? $opal.cm('Element') : $a).$find(document.head);
    };
    return (self._proto.$body = function() {
      var $a, self = this;

      return (($a = $scope.Element) == null ? $opal.cm('Element') : $a).$find(document.body);
    }, nil) && 'body';
  })((($a = $scope.Document) == null ? $opal.cm('Document') : $a).$singleton_class());
  return $gvars.document = (($a = $scope.Document) == null ? $opal.cm('Document') : $a);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$stop', '$prevent']);
  return (function($base, $super) {
    function $Event(){};
    var self = $Event = $klass($base, $super, 'Event', $Event);

    var def = self._proto, $scope = self._scope;

    def["native"] = nil;
    def.$initialize = function(native$) {
      var self = this;

      return self["native"] = native$;
    };

    def['$[]'] = function(name) {
      var self = this;

      return self["native"][name];
    };

    def.$type = function() {
      var self = this;

      return self["native"].type;
    };

    def.$current_target = function() {
      var self = this;

      return $(self["native"].currentTarget);
    };

    def.$target = function() {
      var self = this;

      return $(self["native"].target);
    };

    def['$prevented?'] = function() {
      var self = this;

      return self["native"].isDefaultPrevented();
    };

    def.$prevent = function() {
      var self = this;

      return self["native"].preventDefault();
    };

    def['$stopped?'] = function() {
      var self = this;

      return self["native"].propagationStopped();
    };

    def.$stop = function() {
      var self = this;

      return self["native"].stopPropagation();
    };

    def.$stop_immediate = function() {
      var self = this;

      return self["native"].stopImmediatePropagation();
    };

    def.$kill = function() {
      var self = this;

      self.$stop();
      return self.$prevent();
    };

    $opal.defn(self, '$default_prevented?', def['$prevented?']);

    $opal.defn(self, '$prevent_default', def.$prevent);

    $opal.defn(self, '$propagation_stopped?', def['$stopped?']);

    $opal.defn(self, '$stop_propagation', def.$stop);

    $opal.defn(self, '$stop_immediate_propagation', def.$stop_immediate);

    def.$page_x = function() {
      var self = this;

      return self["native"].pageX;
    };

    def.$page_y = function() {
      var self = this;

      return self["native"].pageY;
    };

    def.$touch_x = function() {
      var self = this;

      return self["native"].originalEvent.touches[0].pageX;
    };

    def.$touch_y = function() {
      var self = this;

      return self["native"].originalEvent.touches[0].pageY;
    };

    def.$ctrl_key = function() {
      var self = this;

      return self["native"].ctrlKey;
    };

    def.$key_code = function() {
      var self = this;

      return self["native"].keyCode;
    };

    return (def.$which = function() {
      var self = this;

      return self["native"].which;
    }, nil) && 'which';
  })(self, null)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $hash2 = $opal.hash2, $klass = $opal.klass;

  $opal.add_stubs(['$new', '$push', '$[]=', '$[]', '$create_id', '$json_create', '$attr_accessor', '$create_id=', '$===', '$parse', '$generate', '$from_object', '$to_json', '$responds_to?', '$to_io', '$write', '$to_s', '$strftime']);
  (function($base) {
    var self = $module($base, 'JSON');

    var def = self._proto, $scope = self._scope, $a;

    
    var $parse  = JSON.parse,
        $hasOwn = Opal.hasOwnProperty;

    function to_opal(value, options) {
      switch (typeof value) {
        case 'string':
          return value;

        case 'number':
          return value;

        case 'boolean':
          return !!value;

        case 'null':
          return nil;

        case 'object':
          if (!value) return nil;

          if (value._isArray) {
            var arr = (options.array_class).$new();

            for (var i = 0, ii = value.length; i < ii; i++) {
              (arr).$push(to_opal(value[i], options));
            }

            return arr;
          }
          else {
            var hash = (options.object_class).$new();

            for (var k in value) {
              if ($hasOwn.call(value, k)) {
                (hash)['$[]='](k, to_opal(value[k], options));
              }
            }

            var klass;
            if ((klass = (hash)['$[]']((($a = $scope.JSON) == null ? $opal.cm('JSON') : $a).$create_id())) != nil) {
              klass = Opal.cget(klass);
              return (klass).$json_create(hash);
            }
            else {
              return hash;
            }
          }
      }
    };
  

    (function(self) {
      var $scope = self._scope, def = self._proto;

      return self.$attr_accessor("create_id")
    })(self.$singleton_class());

    self['$create_id=']("json_class");

    $opal.defs(self, '$[]', function(value, options) {
      var $a, $b, self = this;

      if (options == null) {
        options = $hash2([], {})
      }
      if ((($a = (($b = $scope.String) == null ? $opal.cm('String') : $b)['$==='](value)) !== nil && (!$a._isBoolean || $a == true))) {
        return self.$parse(value, options)
        } else {
        return self.$generate(value, options)
      };
    });

    $opal.defs(self, '$parse', function(source, options) {
      var self = this;

      if (options == null) {
        options = $hash2([], {})
      }
      return self.$from_object($parse(source), options);
    });

    $opal.defs(self, '$parse!', function(source, options) {
      var self = this;

      if (options == null) {
        options = $hash2([], {})
      }
      return self.$parse(source, options);
    });

    $opal.defs(self, '$from_object', function(js_object, options) {
      var $a, $b, $c, $d, self = this;

      if (options == null) {
        options = $hash2([], {})
      }
      ($a = "object_class", $b = options, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, (($d = $scope.Hash) == null ? $opal.cm('Hash') : $d))));
      ($a = "array_class", $b = options, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, (($d = $scope.Array) == null ? $opal.cm('Array') : $d))));
      return to_opal(js_object, options.map);
    });

    $opal.defs(self, '$generate', function(obj, options) {
      var self = this;

      if (options == null) {
        options = $hash2([], {})
      }
      return obj.$to_json(options);
    });

    $opal.defs(self, '$dump', function(obj, io, limit) {
      var $a, self = this, string = nil;

      if (io == null) {
        io = nil
      }
      if (limit == null) {
        limit = nil
      }
      string = self.$generate(obj);
      if (io !== false && io !== nil) {
        if ((($a = io['$responds_to?']("to_io")) !== nil && (!$a._isBoolean || $a == true))) {
          io = io.$to_io()};
        io.$write(string);
        return io;
        } else {
        return string
      };
    });
    
  })(self);
  (function($base, $super) {
    function $Object(){};
    var self = $Object = $klass($base, $super, 'Object', $Object);

    var def = self._proto, $scope = self._scope;

    return ($opal.defn(self, '$to_json', function() {
      var self = this;

      return self.$to_s().$to_json();
    }), nil) && 'to_json'
  })(self, null);
  (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self._proto, $scope = self._scope;

    return (def.$to_json = function() {
      var self = this;

      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        result.push((self[i]).$to_json());
      }

      return '[' + result.join(', ') + ']';
    
    }, nil) && 'to_json'
  })(self, null);
  (function($base, $super) {
    function $Boolean(){};
    var self = $Boolean = $klass($base, $super, 'Boolean', $Boolean);

    var def = self._proto, $scope = self._scope;

    return (def.$to_json = function() {
      var self = this;

      return (self == true) ? 'true' : 'false';
    }, nil) && 'to_json'
  })(self, null);
  (function($base, $super) {
    function $Hash(){};
    var self = $Hash = $klass($base, $super, 'Hash', $Hash);

    var def = self._proto, $scope = self._scope;

    return (def.$to_json = function() {
      var self = this;

      
      var inspect = [], keys = self.keys, map = self.map;

      for (var i = 0, length = keys.length; i < length; i++) {
        var key = keys[i];
        inspect.push((key).$to_s().$to_json() + ':' + (map[key]).$to_json());
      }

      return '{' + inspect.join(', ') + '}';
    ;
    }, nil) && 'to_json'
  })(self, null);
  (function($base, $super) {
    function $NilClass(){};
    var self = $NilClass = $klass($base, $super, 'NilClass', $NilClass);

    var def = self._proto, $scope = self._scope;

    return (def.$to_json = function() {
      var self = this;

      return "null";
    }, nil) && 'to_json'
  })(self, null);
  (function($base, $super) {
    function $Numeric(){};
    var self = $Numeric = $klass($base, $super, 'Numeric', $Numeric);

    var def = self._proto, $scope = self._scope;

    return (def.$to_json = function() {
      var self = this;

      return self.toString();
    }, nil) && 'to_json'
  })(self, null);
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self._proto, $scope = self._scope;

    return $opal.defn(self, '$to_json', def.$inspect)
  })(self, null);
  (function($base, $super) {
    function $Time(){};
    var self = $Time = $klass($base, $super, 'Time', $Time);

    var def = self._proto, $scope = self._scope;

    return (def.$to_json = function() {
      var self = this;

      return self.$strftime("%FT%T%z").$to_json();
    }, nil) && 'to_json'
  })(self, null);
  return (function($base, $super) {
    function $Date(){};
    var self = $Date = $klass($base, $super, 'Date', $Date);

    var def = self._proto, $scope = self._scope;

    def.$to_json = function() {
      var self = this;

      return self.$to_s().$to_json();
    };

    return (def.$as_json = function() {
      var self = this;

      return self.$to_s();
    }, nil) && 'as_json';
  })(self, null);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$attr_reader', '$send!', '$new', '$delete', '$to_n', '$from_object', '$succeed', '$fail', '$call', '$parse', '$xhr']);
  ;
  ;
  return (function($base, $super) {
    function $HTTP(){};
    var self = $HTTP = $klass($base, $super, 'HTTP', $HTTP);

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6;

    def.errback = def.json = def.body = def.ok = def.settings = def.callback = nil;
    self.$attr_reader("body", "error_message", "method", "status_code", "url", "xhr");

    $opal.defs(self, '$get', TMP_1 = function(url, opts) {
      var self = this, $iter = TMP_1._p, block = $iter || nil;

      if (opts == null) {
        opts = $hash2([], {})
      }
      TMP_1._p = null;
      return self.$new(url, "GET", opts, block)['$send!']();
    });

    $opal.defs(self, '$post', TMP_2 = function(url, opts) {
      var self = this, $iter = TMP_2._p, block = $iter || nil;

      if (opts == null) {
        opts = $hash2([], {})
      }
      TMP_2._p = null;
      return self.$new(url, "POST", opts, block)['$send!']();
    });

    $opal.defs(self, '$put', TMP_3 = function(url, opts) {
      var self = this, $iter = TMP_3._p, block = $iter || nil;

      if (opts == null) {
        opts = $hash2([], {})
      }
      TMP_3._p = null;
      return self.$new(url, "PUT", opts, block)['$send!']();
    });

    $opal.defs(self, '$delete', TMP_4 = function(url, opts) {
      var self = this, $iter = TMP_4._p, block = $iter || nil;

      if (opts == null) {
        opts = $hash2([], {})
      }
      TMP_4._p = null;
      return self.$new(url, "DELETE", opts, block)['$send!']();
    });

    def.$initialize = function(url, method, options, handler) {
      var $a, self = this, http = nil, payload = nil, settings = nil;

      if (handler == null) {
        handler = nil
      }
      self.url = url;
      self.method = method;
      self.ok = true;
      self.xhr = nil;
      http = self;
      payload = options.$delete("payload");
      settings = options.$to_n();
      if (handler !== false && handler !== nil) {
        self.callback = self.errback = handler};
      
      if (typeof(payload) === 'string') {
        settings.data = payload;
      }
      else if (payload != nil) {
        settings.data = payload.$to_json();
        settings.contentType = 'application/json';
      }

      settings.url  = url;
      settings.type = method;

      settings.success = function(data, status, xhr) {
        http.body = data;
        http.xhr = xhr;
        http.status_code = xhr.status;

        if (typeof(data) === 'object') {
          http.json = (($a = $scope.JSON) == null ? $opal.cm('JSON') : $a).$from_object(data);
        }

        return http.$succeed();
      };

      settings.error = function(xhr, status, error) {
        http.body = xhr.responseText;
        http.xhr = xhr;
        http.status_code = xhr.status;

        return http.$fail();
      };
    
      return self.settings = settings;
    };

    def.$callback = TMP_5 = function() {
      var self = this, $iter = TMP_5._p, block = $iter || nil;

      TMP_5._p = null;
      self.callback = block;
      return self;
    };

    def.$errback = TMP_6 = function() {
      var self = this, $iter = TMP_6._p, block = $iter || nil;

      TMP_6._p = null;
      self.errback = block;
      return self;
    };

    def.$fail = function() {
      var $a, self = this;

      self.ok = false;
      if ((($a = self.errback) !== nil && (!$a._isBoolean || $a == true))) {
        return self.errback.$call(self)
        } else {
        return nil
      };
    };

    def.$json = function() {
      var $a, $b, self = this;

      return ((($a = self.json) !== false && $a !== nil) ? $a : (($b = $scope.JSON) == null ? $opal.cm('JSON') : $b).$parse(self.body));
    };

    def['$ok?'] = function() {
      var self = this;

      return self.ok;
    };

    def['$send!'] = function() {
      var self = this;

      $.ajax(self.settings);
      return self;
    };

    def.$succeed = function() {
      var $a, self = this;

      if ((($a = self.callback) !== nil && (!$a._isBoolean || $a == true))) {
        return self.callback.$call(self)
        } else {
        return nil
      };
    };

    return (def.$get_header = function(key) {
      var self = this;

      return self.$xhr().getResponseHeader(key);;
    }, nil) && 'get_header';
  })(self, null);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module;

  $opal.add_stubs([]);
  return (function($base) {
    var self = $module($base, 'Kernel');

    var def = self._proto, $scope = self._scope;

    def.$alert = function(msg) {
      var self = this;

      alert(msg);
      return nil;
    }
        ;$opal.donate(self, ["$alert"]);
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice;

  $opal.add_stubs([]);
  ;
  ;
  ;
  ;
  ;
  return true;
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$==', '$each', '$define_method', '$call']);
  if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
    return (function($base, $super) {
      function $Logger(){};
      var self = $Logger = $klass($base, $super, 'Logger', $Logger);

      var def = self._proto, $scope = self._scope, $a, $b, TMP_1;

      def.$initialize = function(args) {
        var self = this;

        args = $slice.call(arguments, 0);
        return nil;
      };

      return ($a = ($b = ["fatal", "info", "warn", "debug", "error"]).$each, $a._p = (TMP_1 = function(method_name){var self = TMP_1._s || this, $a, $b, TMP_2;
if (method_name == null) method_name = nil;
      return ($a = ($b = self).$define_method, $a._p = (TMP_2 = function(text){var self = TMP_2._s || this, block;
if (text == null) text = nil;
          block = TMP_2._p || nil, TMP_2._p = null;
        if (block !== false && block !== nil) {
            text = block.$call()};
          console[method_name](text);}, TMP_2._s = self, TMP_2), $a).call($b, method_name)}, TMP_1._s = self, TMP_1), $a).call($b);
    })(self, null)}
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$each', '$+']);
  return (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self._proto, $scope = self._scope;

    return (def.$sum = function() {
      var $a, $b, TMP_1, self = this, total = nil;

      total = 0;
      ($a = ($b = self).$each, $a._p = (TMP_1 = function(val){var self = TMP_1._s || this;
if (val == null) val = nil;
      return total = total['$+'](val)}, TMP_1._s = self, TMP_1), $a).call($b);
      return total;
    }, nil) && 'sum'
  })(self, null)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $range = $opal.range;

  $opal.add_stubs(['$[]', '$map', '$instance_variable_get', '$instance_variables', '$!', '$nil?', '$gsub', '$inspect', '$load', '$dump', '$empty?', '$respond_to?', '$first', '$public_send', '$to_proc']);
  return (function($base, $super) {
    function $Object(){};
    var self = $Object = $klass($base, $super, 'Object', $Object);

    var def = self._proto, $scope = self._scope, TMP_2;

    $opal.defn(self, '$instance_values', function() {
      var $a, $b, TMP_1, self = this;

      return (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a)['$[]'](($a = ($b = self.$instance_variables()).$map, $a._p = (TMP_1 = function(name){var self = TMP_1._s || this;
if (name == null) name = nil;
      return [name['$[]']($range(1, -1, false)), self.$instance_variable_get(name)]}, TMP_1._s = self, TMP_1), $a).call($b));
    });

    $opal.defn(self, '$or', function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = self !== false && self !== nil) ? self['$nil?']()['$!']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return self
        } else {
        return other
      };
    });

    $opal.defn(self, '$and', function(other) {
      var $a, $b, self = this;

      if ((($a = (($b = self !== false && self !== nil) ? self['$nil?']()['$!']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return other
        } else {
        return self
      };
    });

    $opal.defn(self, '$html_inspect', function() {
      var self = this;

      return self.$inspect().$gsub("<", "&lt;").$gsub(">", "&gt;");
    });

    $opal.defn(self, '$deep_clone', function() {
      var $a, self = this;

      return (($a = $scope.Marshal) == null ? $opal.cm('Marshal') : $a).$load((($a = $scope.Marshal) == null ? $opal.cm('Marshal') : $a).$dump(self));
    });

    return ($opal.defn(self, '$try', TMP_2 = function(a) {
      var $a, $b, self = this, $iter = TMP_2._p, b = $iter || nil;

      a = $slice.call(arguments, 0);
      TMP_2._p = null;
      if ((($a = ($b = a['$empty?'](), $b !== false && $b !== nil ?(b !== nil) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return $a = $opal.$yield1(b, self), $a === $breaker ? $a : $a
      } else if ((($a = self['$respond_to?'](a.$first())) !== nil && (!$a._isBoolean || $a == true))) {
        return ($a = ($b = self).$public_send, $a._p = b.$to_proc(), $a).apply($b, [].concat(a))
        } else {
        return nil
      };
    }), nil) && 'try';
  })(self, null)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$respond_to?', '$empty?', '$!', '$blank?', '$alias_method', '$==', '$strip']);
  (function($base, $super) {
    function $Object(){};
    var self = $Object = $klass($base, $super, 'Object', $Object);

    var def = self._proto, $scope = self._scope;

    $opal.defn(self, '$blank?', function() {
      var $a, self = this;

      if ((($a = self['$respond_to?']("empty?")) !== nil && (!$a._isBoolean || $a == true))) {
        return self['$empty?']()
        } else {
        return self['$!']()
      };
    });

    return ($opal.defn(self, '$present?', function() {
      var self = this;

      return self['$blank?']()['$!']();
    }), nil) && 'present?';
  })(self, null);
  (function($base, $super) {
    function $NilClass(){};
    var self = $NilClass = $klass($base, $super, 'NilClass', $NilClass);

    var def = self._proto, $scope = self._scope;

    return (def['$blank?'] = function() {
      var self = this;

      return true;
    }, nil) && 'blank?'
  })(self, null);
  (function($base, $super) {
    function $FalseClass(){};
    var self = $FalseClass = $klass($base, $super, 'FalseClass', $FalseClass);

    var def = self._proto, $scope = self._scope;

    return (def['$blank?'] = function() {
      var self = this;

      return true;
    }, nil) && 'blank?'
  })(self, null);
  (function($base, $super) {
    function $TrueClass(){};
    var self = $TrueClass = $klass($base, $super, 'TrueClass', $TrueClass);

    var def = self._proto, $scope = self._scope;

    return (def['$blank?'] = function() {
      var self = this;

      return false;
    }, nil) && 'blank?'
  })(self, null);
  (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self._proto, $scope = self._scope;

    return self.$alias_method("blank?", "empty?")
  })(self, null);
  (function($base, $super) {
    function $Hash(){};
    var self = $Hash = $klass($base, $super, 'Hash', $Hash);

    var def = self._proto, $scope = self._scope;

    return self.$alias_method("blank?", "empty?")
  })(self, null);
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self._proto, $scope = self._scope;

    return (def['$blank?'] = function() {
      var self = this;

      return self.$strip()['$==']("");
    }, nil) && 'blank?'
  })(self, null);
  return (function($base, $super) {
    function $Numeric(){};
    var self = $Numeric = $klass($base, $super, 'Numeric', $Numeric);

    var def = self._proto, $scope = self._scope;

    return (def['$blank?'] = function() {
      var self = this;

      return false;
    }, nil) && 'blank?'
  })(self, null);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$each_with_object', '$[]=', '$to_s', '$to_sym']);
  return (function($base, $super) {
    function $Object(){};
    var self = $Object = $klass($base, $super, 'Object', $Object);

    var def = self._proto, $scope = self._scope;

    $opal.defn(self, '$stringify_keys', function() {
      var $a, $b, TMP_1, self = this;

      return ($a = ($b = self).$each_with_object, $a._p = (TMP_1 = function($c, hash){var self = TMP_1._s || this;
key = $c[0];value = $c[1];if (hash == null) hash = nil;
      return hash['$[]='](key.$to_s(), value)}, TMP_1._s = self, TMP_1), $a).call($b, $hash2([], {}));
    });

    return ($opal.defn(self, '$symbolize_keys', function() {
      var $a, $b, TMP_2, self = this;

      return ($a = ($b = self).$each_with_object, $a._p = (TMP_2 = function($c, hash){var self = TMP_2._s || this;
key = $c[0];value = $c[1];if (hash == null) hash = nil;
      return hash['$[]='](key.$to_sym(), value)}, TMP_2._s = self, TMP_2), $a).call($b, $hash2([], {}));
    }), nil) && 'symbolize_keys';
  })(self, null)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2, $range = $opal.range;

  $opal.add_stubs(['$[]', '$[]=', '$new', '$attr_reader', '$each', '$instance_variable_set', '$dup', '$send', '$downcase', '$join', '$values', '$is_a?', '$delete', '$insert', '$==', '$upcase', '$plural', '$+', '$singular', '$flatten!', '$<<', '$===', '$instance']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'Inflector');

      var def = self._proto, $scope = self._scope, TMP_2;

      (function($base, $super) {
        function $Inflections(){};
        var self = $Inflections = $klass($base, $super, 'Inflections', $Inflections);

        var def = self._proto, $scope = self._scope;

        def.acronyms = def.uncountables = def.plurals = def.singulars = def.humans = nil;
        self.__instance__ = $hash2([], {});

        $opal.defs(self, '$instance', function(locale) {
          var $a, $b, $c, self = this;
          if (self.__instance__ == null) self.__instance__ = nil;

          if (locale == null) {
            locale = "en"
          }
          return ($a = locale, $b = self.__instance__, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, self.$new())));
        });

        self.$attr_reader("plurals", "singulars", "uncountables", "humans", "acronyms", "acronym_regex");

        def.$initialize = function() {
          var $a, self = this;

          return $a = [[], [], [], [], $hash2([], {}), /(?=a)b/], self.plurals = $a[0], self.singulars = $a[1], self.uncountables = $a[2], self.humans = $a[3], self.acronyms = $a[4], self.acronym_regex = $a[5];
        };

        def.$initialize_dup = function(orig) {
          var $a, $b, TMP_1, self = this;

          return ($a = ($b = ["plurals", "singulars", "uncountables", "humans", "acronyms", "acronym_regex"]).$each, $a._p = (TMP_1 = function(scope){var self = TMP_1._s || this;
if (scope == null) scope = nil;
          return self.$instance_variable_set("@" + (scope), orig.$send(scope).$dup())}, TMP_1._s = self, TMP_1), $a).call($b);
        };

        def.$acronym = function(word) {
          var self = this;

          self.acronyms['$[]='](word.$downcase(), word);
          return self.acronym_regex = (new RegExp("" + self.acronyms.$values().$join("|")));
        };

        def.$plural = function(rule, replacement) {
          var $a, $b, self = this;

          if ((($a = rule['$is_a?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            self.uncountables.$delete(rule)};
          self.uncountables.$delete(replacement);
          return self.plurals.$insert(0, [rule, replacement]);
        };

        def.$singular = function(rule, replacement) {
          var $a, $b, self = this;

          if ((($a = rule['$is_a?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            self.uncountables.$delete(rule)};
          self.uncountables.$delete(replacement);
          return self.singulars.$insert(0, [rule, replacement]);
        };

        def.$irregular = function(singular, plural) {
          var self = this, s0 = nil, srest = nil, p0 = nil, prest = nil;

          self.uncountables.$delete(singular);
          self.uncountables.$delete(plural);
          s0 = singular['$[]'](0);
          srest = singular['$[]']($range(1, -1, false));
          p0 = plural['$[]'](0);
          prest = plural['$[]']($range(1, -1, false));
          if (s0.$upcase()['$=='](p0.$upcase())) {
            self.$plural((new RegExp("(" + s0 + ")" + srest + "$")), "\\1"['$+'](prest));
            self.$plural((new RegExp("(" + p0 + ")" + prest + "$")), "\\1"['$+'](prest));
            self.$singular((new RegExp("(" + s0 + ")" + srest + "$")), "\\1"['$+'](srest));
            return self.$singular((new RegExp("(" + p0 + ")" + prest + "$")), "\\1"['$+'](srest));
            } else {
            self.$plural((new RegExp("" + s0.$upcase() + "(?i)" + srest + "$")), p0.$upcase()['$+'](prest));
            self.$plural((new RegExp("" + s0.$downcase() + "(?i)" + srest + "$")), p0.$downcase()['$+'](prest));
            self.$plural((new RegExp("" + p0.$upcase() + "(?i)" + prest + "$")), p0.$upcase()['$+'](prest));
            self.$plural((new RegExp("" + p0.$downcase() + "(?i)" + prest + "$")), p0.$downcase()['$+'](prest));
            self.$singular((new RegExp("" + s0.$upcase() + "(?i)" + srest + "$")), s0.$upcase()['$+'](srest));
            self.$singular((new RegExp("" + s0.$downcase() + "(?i)" + srest + "$")), s0.$downcase()['$+'](srest));
            self.$singular((new RegExp("" + p0.$upcase() + "(?i)" + prest + "$")), s0.$upcase()['$+'](srest));
            return self.$singular((new RegExp("" + p0.$downcase() + "(?i)" + prest + "$")), s0.$downcase()['$+'](srest));
          };
        };

        def.$uncountable = function(words) {
          var self = this;

          words = $slice.call(arguments, 0);
          return (self.uncountables['$<<'](words))['$flatten!']();
        };

        def.$human = function(rule, replacement) {
          var self = this;

          return self.humans.$insert(0, [rule, replacement]);
        };

        return (def.$clear = function(scope) {
          var $a, self = this, $case = nil;

          if (scope == null) {
            scope = "all"
          }
          return (function() {$case = scope;if ("all"['$===']($case)) {return $a = [[], [], [], []], self.plurals = $a[0], self.singulars = $a[1], self.uncountables = $a[2], self.humans = $a[3]}else {return self.$instance_variable_set("@" + (scope), [])}})();
        }, nil) && 'clear';
      })(self, null);

      $opal.defs(self, '$inflections', TMP_2 = function(locale) {
        var $a, self = this, $iter = TMP_2._p, $yield = $iter || nil;

        if (locale == null) {
          locale = "en"
        }
        TMP_2._p = null;
        if (($yield !== nil)) {
          return $a = $opal.$yield1($yield, (($a = $scope.Inflections) == null ? $opal.cm('Inflections') : $a).$instance(locale)), $a === $breaker ? $a : $a
          } else {
          return (($a = $scope.Inflections) == null ? $opal.cm('Inflections') : $a).$instance(locale)
        };
      });
      
    })(self)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module;

  $opal.add_stubs(['$apply_inflections', '$plurals', '$inflections', '$singulars', '$private', '$dup', '$to_s', '$empty?', '$include?', '$uncountables', '$[]', '$downcase', '$each', '$match', '$sub']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'Inflector');

      var def = self._proto, $scope = self._scope;

      $opal.defs(self, '$pluralize', function(word, locale) {
        var self = this;

        if (locale == null) {
          locale = "en"
        }
        return self.$apply_inflections(word, self.$inflections(locale).$plurals());
      });

      $opal.defs(self, '$singularize', function(word, locale) {
        var self = this;

        if (locale == null) {
          locale = "en"
        }
        return self.$apply_inflections(word, self.$inflections(locale).$singulars());
      });

      self.$private();

      $opal.defs(self, '$apply_inflections', function(word, rules) {
        var $a, $b, TMP_1, self = this, result = nil;

        result = word.$to_s().$dup();
        if ((($a = ((($b = word['$empty?']()) !== false && $b !== nil) ? $b : self.$inflections().$uncountables()['$include?'](result.$downcase()['$[]'](/\b\w+\Z/)))) !== nil && (!$a._isBoolean || $a == true))) {
          return result
          } else {
          ($a = ($b = rules).$each, $a._p = (TMP_1 = function(rule, replacement){var self = TMP_1._s || this, $a;
if (rule == null) rule = nil;if (replacement == null) replacement = nil;
          if ((($a = result.$match(rule)) !== nil && (!$a._isBoolean || $a == true))) {
              result = result.$sub(rule, replacement);
              return ($breaker.$v = nil, $breaker);
              } else {
              return nil
            }}, TMP_1._s = self, TMP_1), $a).call($b);
          return result;
        };
      });
      
    })(self)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, $b, TMP_1, $c, $d, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice;

  $opal.add_stubs(['$inflections', '$plural', '$singular', '$irregular', '$uncountable']);
  ;
  return ($a = ($b = (($c = ((($d = $scope.Volt) == null ? $opal.cm('Volt') : $d))._scope).Inflector == null ? $c.cm('Inflector') : $c.Inflector)).$inflections, $a._p = (TMP_1 = function(inflect){var self = TMP_1._s || this;
if (inflect == null) inflect = nil;
  inflect.$plural(/$/, "s");
    inflect.$plural(/s$/i, "s");
    inflect.$plural(/^(ax|test)is$/i, "\\1es");
    inflect.$plural(/(octop|vir)us$/i, "\\1i");
    inflect.$plural(/(octop|vir)i$/i, "\\1i");
    inflect.$plural(/(alias|status)$/i, "\\1es");
    inflect.$plural(/(bu)s$/i, "\\1ses");
    inflect.$plural(/(buffal|tomat)o$/i, "\\1oes");
    inflect.$plural(/([ti])um$/i, "\\1a");
    inflect.$plural(/([ti])a$/i, "\\1a");
    inflect.$plural(/sis$/i, "ses");
    inflect.$plural(/(?:([^f])fe|([lr])f)$/i, "\\1\\2ves");
    inflect.$plural(/(hive)$/i, "\\1s");
    inflect.$plural(/([^aeiouy]|qu)y$/i, "\\1ies");
    inflect.$plural(/(x|ch|ss|sh)$/i, "\\1es");
    inflect.$plural(/(matr|vert|ind)(?:ix|ex)$/i, "\\1ices");
    inflect.$plural(/^(m|l)ouse$/i, "\\1ice");
    inflect.$plural(/^(m|l)ice$/i, "\\1ice");
    inflect.$plural(/^(ox)$/i, "\\1en");
    inflect.$plural(/^(oxen)$/i, "\\1");
    inflect.$plural(/(quiz)$/i, "\\1zes");
    inflect.$singular(/s$/i, "");
    inflect.$singular(/(ss)$/i, "\\1");
    inflect.$singular(/(n)ews$/i, "\\1ews");
    inflect.$singular(/([ti])a$/i, "\\1um");
    inflect.$singular(/((a)naly|(b)a|(d)iagno|(p)arenthe|(p)rogno|(s)ynop|(t)he)(sis|ses)$/i, "\\1sis");
    inflect.$singular(/(^analy)(sis|ses)$/i, "\\1sis");
    inflect.$singular(/([^f])ves$/i, "\\1fe");
    inflect.$singular(/(hive)s$/i, "\\1");
    inflect.$singular(/(tive)s$/i, "\\1");
    inflect.$singular(/([lr])ves$/i, "\\1f");
    inflect.$singular(/([^aeiouy]|qu)ies$/i, "\\1y");
    inflect.$singular(/(s)eries$/i, "\\1eries");
    inflect.$singular(/(m)ovies$/i, "\\1ovie");
    inflect.$singular(/(x|ch|ss|sh)es$/i, "\\1");
    inflect.$singular(/^(m|l)ice$/i, "\\1ouse");
    inflect.$singular(/(bus)(es)?$/i, "\\1");
    inflect.$singular(/(o)es$/i, "\\1");
    inflect.$singular(/(shoe)s$/i, "\\1");
    inflect.$singular(/(cris|test)(is|es)$/i, "\\1is");
    inflect.$singular(/^(a)x[ie]s$/i, "\\1xis");
    inflect.$singular(/(octop|vir)(us|i)$/i, "\\1us");
    inflect.$singular(/(alias|status)(es)?$/i, "\\1");
    inflect.$singular(/^(ox)en/i, "\\1");
    inflect.$singular(/(vert|ind)ices$/i, "\\1ex");
    inflect.$singular(/(matr)ices$/i, "\\1ix");
    inflect.$singular(/(quiz)zes$/i, "\\1");
    inflect.$singular(/(database)s$/i, "\\1");
    inflect.$irregular("person", "people");
    inflect.$irregular("man", "men");
    inflect.$irregular("child", "children");
    inflect.$irregular("sex", "sexes");
    inflect.$irregular("move", "moves");
    inflect.$irregular("zombie", "zombies");
    return inflect.$uncountable(["equipment", "information", "rice", "money", "species", "series", "fish", "sheep", "jeans", "police"]);}, TMP_1._s = self, TMP_1), $a).call($b, "en");
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice;

  $opal.add_stubs([]);
  ;
  ;
  return true;
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $range = $opal.range;

  $opal.add_stubs(['$gsub', '$upcase', '$[]', '$==', '$+', '$capitalize', '$downcase', '$pluralize', '$singularize', '$join', '$map', '$to_proc', '$split']);
  ;
  return (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self._proto, $scope = self._scope;

    def.$camelize = function(first_letter) {
      var $a, $b, TMP_1, self = this, new_str = nil;

      if (first_letter == null) {
        first_letter = "upper"
      }
      new_str = ($a = ($b = self).$gsub, $a._p = (TMP_1 = function(a){var self = TMP_1._s || this;
if (a == null) a = nil;
      return a['$[]'](1).$upcase()}, TMP_1._s = self, TMP_1), $a).call($b, /_[a-z]/);
      if (first_letter['$==']("upper")) {
        new_str = new_str['$[]'](0).$capitalize()['$+'](new_str['$[]']($range(1, -1, false)))};
      return new_str;
    };

    def.$underscore = function() {
      var self = this;

      return self.$gsub(/([A-Z]+)([A-Z][a-z])/, "\\1_\\2").$gsub(/([a-z\d])([A-Z])/, "\\1_\\2").$downcase();
    };

    def.$dasherize = function() {
      var self = this;

      return self.$gsub("_", "-");
    };

    def.$pluralize = function() {
      var $a, $b, self = this;

      return (($a = ((($b = $scope.Volt) == null ? $opal.cm('Volt') : $b))._scope).Inflector == null ? $a.cm('Inflector') : $a.Inflector).$pluralize(self);
    };

    def.$singularize = function() {
      var $a, $b, self = this;

      return (($a = ((($b = $scope.Volt) == null ? $opal.cm('Volt') : $b))._scope).Inflector == null ? $a.cm('Inflector') : $a.Inflector).$singularize(self);
    };

    def.$titleize = function() {
      var $a, $b, self = this;

      return ($a = ($b = self.$gsub("_", " ").$split(" ")).$map, $a._p = "capitalize".$to_proc(), $a).call($b).$join(" ");
    };

    def['$plural?'] = function() {
      var self = this;

      return self.$pluralize()['$=='](self);
    };

    return (def['$singular?'] = function() {
      var self = this;

      return self.$singularize()['$=='](self);
    }, nil) && 'singular?';
  })(self, null);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$==']);
  return (function($base, $super) {
    function $Numeric(){};
    var self = $Numeric = $klass($base, $super, 'Numeric', $Numeric);

    var def = self._proto, $scope = self._scope;

    return (def.$in_units_of = function(unit) {
      var self = this;

      if (self['$=='](1)) {
        return "1 " + (unit)
        } else {
        return "" + (self) + " " + (unit) + "s"
      };
    }, nil) && 'in_units_of'
  })(self, null)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs([]);
  (function($base, $super) {
    function $Object(){};
    var self = $Object = $klass($base, $super, 'Object', $Object);

    var def = self._proto, $scope = self._scope;

    $opal.defn(self, '$true?', function() {
      var self = this;

      return true;
    });

    return ($opal.defn(self, '$false?', function() {
      var self = this;

      return false;
    }), nil) && 'false?';
  })(self, null);
  (function($base, $super) {
    function $FalseClass(){};
    var self = $FalseClass = $klass($base, $super, 'FalseClass', $FalseClass);

    var def = self._proto, $scope = self._scope;

    def['$true?'] = function() {
      var self = this;

      return false;
    };

    return (def['$false?'] = function() {
      var self = this;

      return true;
    }, nil) && 'false?';
  })(self, null);
  (function($base, $super) {
    function $NilClass(){};
    var self = $NilClass = $klass($base, $super, 'NilClass', $NilClass);

    var def = self._proto, $scope = self._scope;

    def['$true?'] = function() {
      var self = this;

      return false;
    };

    return (def['$false?'] = function() {
      var self = this;

      return true;
    }, nil) && 'false?';
  })(self, null);
  return (function($base, $super) {
    function $Boolean(){};
    var self = $Boolean = $klass($base, $super, 'Boolean', $Boolean);

    var def = self._proto, $scope = self._scope;

    def['$true?'] = function() {
      var self = this;

      return self;
    };

    return (def['$false?'] = function() {
      var self = this;

      return self;
    }, nil) && 'false?';
  })(self, null);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$each', '$define_singleton_method', '$class_eval', '$remove_possible_method', '$define_method', '$singleton_class', '$method_defined?', '$private_method_defined?', '$undef_method']);
  return (function($base, $super) {
    function $Class(){};
    var self = $Class = $klass($base, $super, 'Class', $Class);

    var def = self._proto, $scope = self._scope;

    def.$class_attribute = function(attrs) {
      var $a, $b, TMP_1, self = this;

      attrs = $slice.call(arguments, 0);
      return ($a = ($b = attrs).$each, $a._p = (TMP_1 = function(name){var self = TMP_1._s || this, $a, $b, TMP_2, $c, TMP_3, ivar = nil;
if (name == null) name = nil;
      ($a = ($b = self).$define_singleton_method, $a._p = (TMP_2 = function(){var self = TMP_2._s || this;

        return nil}, TMP_2._s = self, TMP_2), $a).call($b, name);
        ivar = "@" + (name);
        return ($a = ($c = self).$define_singleton_method, $a._p = (TMP_3 = function(val){var self = TMP_3._s || this, $a, $b, TMP_4;
if (val == null) val = nil;
        ($a = ($b = self.$singleton_class()).$class_eval, $a._p = (TMP_4 = function(){var self = TMP_4._s || this, $a, $b, TMP_5;

          self.$remove_possible_method(name);
            return ($a = ($b = self).$define_method, $a._p = (TMP_5 = function(){var self = TMP_5._s || this;

            return val}, TMP_5._s = self, TMP_5), $a).call($b, name);}, TMP_4._s = self, TMP_4), $a).call($b);
          return val;}, TMP_3._s = self, TMP_3), $a).call($c, "" + (name) + "=");}, TMP_1._s = self, TMP_1), $a).call($b);
    };

    return (def.$remove_possible_method = function(method) {
      var $a, $b, self = this;

      if ((($a = ((($b = self['$method_defined?'](method)) !== false && $b !== nil) ? $b : self['$private_method_defined?'](method))) !== nil && (!$a._isBoolean || $a == true))) {
        return self.$undef_method(method)
        } else {
        return nil
      };
    }, nil) && 'remove_possible_method';
  })(self, null)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice;

  $opal.add_stubs(['$==']);
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
    return nil};
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $hash2 = $opal.hash2;

  $opal.add_stubs(['$is_a?', '$new_array_model', '$merge', '$+', '$path', '$new_model', '$map', '$wrap_value', '$to_sym', '$[]']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'ModelWrapper');

      var def = self._proto, $scope = self._scope;

      def.$wrap_value = function(value, lookup) {
        var $a, $b, self = this;
        if (self.options == null) self.options = nil;

        if ((($a = value['$is_a?']((($b = $scope.Array) == null ? $opal.cm('Array') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
          return self.$new_array_model(value, self.options.$merge($hash2(["parent", "path"], {"parent": self, "path": self.$path()['$+'](lookup)})))
        } else if ((($a = value['$is_a?']((($b = $scope.Hash) == null ? $opal.cm('Hash') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
          return self.$new_model(value, self.options.$merge($hash2(["parent", "path"], {"parent": self, "path": self.$path()['$+'](lookup)})))
          } else {
          return value
        };
      };

      def.$wrap_values = function(values, lookup) {
        var $a, $b, TMP_1, $c, TMP_2, self = this, pairs = nil;

        if (lookup == null) {
          lookup = []
        }
        if ((($a = values['$is_a?']((($b = $scope.Array) == null ? $opal.cm('Array') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
          return ($a = ($b = values).$map, $a._p = (TMP_1 = function(v){var self = TMP_1._s || this;
if (v == null) v = nil;
          return self.$wrap_value(v, lookup['$+'](["[]"]))}, TMP_1._s = self, TMP_1), $a).call($b)
        } else if ((($a = values['$is_a?']((($c = $scope.Hash) == null ? $opal.cm('Hash') : $c))) !== nil && (!$a._isBoolean || $a == true))) {
          pairs = ($a = ($c = values).$map, $a._p = (TMP_2 = function(k, v){var self = TMP_2._s || this, path = nil;
if (k == null) k = nil;if (v == null) v = nil;
          path = lookup['$+']([k.$to_sym()]);
            return [k, self.$wrap_value(v, path)];}, TMP_2._s = self, TMP_2), $a).call($c);
          return (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a)['$[]'](pairs);
          } else {
          return values
        };
      };
            ;$opal.donate(self, ["$wrap_value", "$wrap_values"]);
    })(self)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$call', '$remove_listener', '$object_id', '$to_sym', '$new', '$[]', '$[]=', '$<<', '$==', '$size', '$respond_to?', '$event_added', '$each', '$dup', '$fail', '$inspect', '$delete', '$event_removed']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $Listener(){};
      var self = $Listener = $klass($base, $super, 'Listener', $Listener);

      var def = self._proto, $scope = self._scope;

      def.removed = def.callback = def.klass = def.event = nil;
      def.$initialize = function(klass, event, callback) {
        var self = this;

        self.klass = klass;
        self.event = event;
        return self.callback = callback;
      };

      def.$call = function(args) {
        var $a, self = this;

        args = $slice.call(arguments, 0);
        if ((($a = self.removed) !== nil && (!$a._isBoolean || $a == true))) {
          return nil
          } else {
          return ($a = self.callback).$call.apply($a, [].concat(args))
        };
      };

      def.$remove = function() {
        var self = this;

        self.removed = true;
        self.klass.$remove_listener(self.event, self);
        self.klass = nil;
        return self.callback = nil;
      };

      return (def.$inspect = function() {
        var self = this;

        return "<Listener:" + (self.$object_id()) + " event=" + (self.event) + ">";
      }, nil) && 'inspect';
    })(self, null);

    (function($base) {
      var self = $module($base, 'Eventable');

      var def = self._proto, $scope = self._scope, TMP_1;

      def.$on = TMP_1 = function(event) {
        var $a, $b, $c, self = this, $iter = TMP_1._p, callback = $iter || nil, listener = nil, first_for_event = nil, first = nil;
        if (self.listeners == null) self.listeners = nil;

        TMP_1._p = null;
        event = event.$to_sym();
        listener = (($a = $scope.Listener) == null ? $opal.cm('Listener') : $a).$new(self, event, callback);
        ((($a = self.listeners) !== false && $a !== nil) ? $a : self.listeners = $hash2([], {}));
        ($a = event, $b = self.listeners, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, [])));
        self.listeners['$[]'](event)['$<<'](listener);
        first_for_event = self.listeners['$[]'](event).$size()['$=='](1);
        first = (($a = first_for_event !== false && first_for_event !== nil) ? self.listeners.$size()['$=='](1) : $a);
        if ((($a = self['$respond_to?']("event_added")) !== nil && (!$a._isBoolean || $a == true))) {
          self.$event_added(event, first, first_for_event)};
        return listener;
      };

      def['$trigger!'] = function(event, args) {
        var $a, $b, TMP_2, self = this;
        if (self.listeners == null) self.listeners = nil;

        args = $slice.call(arguments, 1);
        event = event.$to_sym();
        if ((($a = ($b = self.listeners, $b !== false && $b !== nil ?self.listeners['$[]'](event) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          return nil
        };
        return ($a = ($b = self.listeners['$[]'](event).$dup()).$each, $a._p = (TMP_2 = function(listener){var self = TMP_2._s || this, $a;
if (listener == null) listener = nil;
        return ($a = listener).$call.apply($a, [].concat(args))}, TMP_2._s = self, TMP_2), $a).call($b);
      };

      def.$remove_listener = function(event, listener) {
        var $a, $b, self = this, last_for_event = nil, last = nil;
        if (self.listeners == null) self.listeners = nil;

        event = event.$to_sym();
        if ((($a = ($b = self.listeners, $b !== false && $b !== nil ?self.listeners['$[]'](event) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          self.$fail("Unable to delete " + (event) + " from " + (self.$inspect()))
        };
        self.listeners['$[]'](event).$delete(listener);
        last_for_event = self.listeners['$[]'](event).$size()['$=='](0);
        if (last_for_event !== false && last_for_event !== nil) {
          self.listeners.$delete(event)};
        last = (($a = last_for_event !== false && last_for_event !== nil) ? self.listeners.$size()['$=='](0) : $a);
        if ((($a = self['$respond_to?']("event_removed")) !== nil && (!$a._isBoolean || $a == true))) {
          return self.$event_removed(event, last, last_for_event)
          } else {
          return nil
        };
      };
            ;$opal.donate(self, ["$on", "$trigger!", "$remove_listener"]);
    })(self);
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$new', '$send', '$to_proc', '$==', '$each', '$depend', '$empty?', '$times', '$true?', '$call', '$[]', '$+', '$size', '$<<', '$any?', '$all?', '$<', '$[]=', '$trigger_for_index!', '$trigger_size_change!', '$alias_method', '$delete_at', '$remove', '$trigger_removed!', '$upto', '$removed', '$index', '$-', '$changed!', '$trigger_added!', '$fail', '$dup', '$insert', '$class', '$object_id', '$inspect', '$private', '$!', '$trigger!']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $ReactiveArray(){};
      var self = $ReactiveArray = $klass($base, $super, 'ReactiveArray', $ReactiveArray);

      var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2, TMP_3, TMP_6, TMP_7, TMP_9;

      def.array = def.size_dep = def.array_deps = def.persistor = def.old_size = nil;
      self.$include((($a = $scope.Eventable) == null ? $opal.cm('Eventable') : $a));

      def.$initialize = function(array) {
        var $a, self = this;

        if (array == null) {
          array = []
        }
        self.array = array;
        self.array_deps = [];
        self.size_dep = (($a = $scope.Dependency) == null ? $opal.cm('Dependency') : $a).$new();
        return self.old_size = 0;
      };

      def.$method_missing = TMP_1 = function(method_name, args) {
        var $a, $b, self = this, $iter = TMP_1._p, block = $iter || nil;

        args = $slice.call(arguments, 1);
        TMP_1._p = null;
        return ($a = ($b = self.array).$send, $a._p = block.$to_proc(), $a).apply($b, [method_name].concat(args));
      };

      def['$=='] = function(args) {
        var $a, self = this;

        args = $slice.call(arguments, 0);
        return ($a = self.array)['$=='].apply($a, [].concat(args));
      };

      def.$each = TMP_2 = function() {
        var $a, $b, self = this, $iter = TMP_2._p, block = $iter || nil;

        TMP_2._p = null;
        return ($a = ($b = self.array).$each, $a._p = block.$to_proc(), $a).call($b);
      };

      def['$empty?'] = function() {
        var self = this;

        self.size_dep.$depend();
        return self.array['$empty?']();
      };

      def.$count = TMP_3 = function() {
        var $a, $b, TMP_4, self = this, $iter = TMP_3._p, block = $iter || nil, count = nil;

        TMP_3._p = null;
        if (block !== false && block !== nil) {
          count = 0;
          ($a = ($b = self.$size()).$times, $a._p = (TMP_4 = function(index){var self = TMP_4._s || this, $a;
if (index == null) index = nil;
          if ((($a = block.$call(self['$[]'](index))['$true?']()) !== nil && (!$a._isBoolean || $a == true))) {
              return count = count['$+'](1)
              } else {
              return nil
            }}, TMP_4._s = self, TMP_4), $a).call($b);
          return count;
          } else {
          return self.$size()
        };
      };

      def.$select = TMP_6 = function() {
        var $a, $b, TMP_5, self = this, $iter = TMP_6._p, $yield = $iter || nil, result = nil;

        TMP_6._p = null;
        result = [];
        ($a = ($b = self.$size()).$times, $a._p = (TMP_5 = function(index){var self = TMP_5._s || this, $a, $b, val = nil;
if (index == null) index = nil;
        val = self['$[]'](index);
          if ((($a = ((($b = $opal.$yield1($yield, val)) === $breaker) ? $breaker.$v : $b)['$true?']()) !== nil && (!$a._isBoolean || $a == true))) {
            return result['$<<'](val)
            } else {
            return nil
          };}, TMP_5._s = self, TMP_5), $a).call($b);
        return result;
      };

      def['$any?'] = TMP_7 = function() {try {

        var $a, $b, TMP_8, self = this, $iter = TMP_7._p, $yield = $iter || nil;

        TMP_7._p = null;
        if (($yield !== nil)) {
          ($a = ($b = self.$size()).$times, $a._p = (TMP_8 = function(index){var self = TMP_8._s || this, $a, $b, val = nil;
if (index == null) index = nil;
          val = self['$[]'](index);
            if ((($a = ((($b = $opal.$yield1($yield, val)) === $breaker) ? $breaker.$v : $b)['$true?']()) !== nil && (!$a._isBoolean || $a == true))) {
              $opal.$return(true)
              } else {
              return nil
            };}, TMP_8._s = self, TMP_8), $a).call($b);
          return false;
          } else {
          return self.array['$any?']()
        };
        } catch ($returner) { if ($returner === $opal.returner) { return $returner.$v } throw $returner; }
      };

      def['$all?'] = TMP_9 = function() {try {

        var $a, $b, TMP_10, self = this, $iter = TMP_9._p, $yield = $iter || nil;

        TMP_9._p = null;
        if (($yield !== nil)) {
          ($a = ($b = self.$size()).$times, $a._p = (TMP_10 = function(index){var self = TMP_10._s || this, $a, $b, val = nil;
if (index == null) index = nil;
          val = self['$[]'](index);
            if ((($a = ((($b = $opal.$yield1($yield, val)) === $breaker) ? $breaker.$v : $b)['$true?']()) !== nil && (!$a._isBoolean || $a == true))) {
              return nil
              } else {
              $opal.$return(false)
            };}, TMP_10._s = self, TMP_10), $a).call($b);
          return true;
          } else {
          return self.array['$all?']()
        };
        } catch ($returner) { if ($returner === $opal.returner) { return $returner.$v } throw $returner; }
      };

      def['$[]'] = function(index) {
        var $a, $b, $c, $d, self = this, dep = nil;

        if (index['$<'](0)) {
          index = self.$size()['$+'](index)};
        dep = (($a = index, $b = self.array_deps, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, (($d = $scope.Dependency) == null ? $opal.cm('Dependency') : $d).$new()))));
        dep.$depend();
        return self.array['$[]'](index);
      };

      def['$[]='] = function(index, value) {
        var self = this;

        self.array['$[]='](index, value);
        self['$trigger_for_index!'](index);
        return self['$trigger_size_change!']();
      };

      def.$size = function() {
        var self = this;

        self.size_dep.$depend();
        return self.array.$size();
      };

      self.$alias_method("length", "size");

      def.$delete_at = function(index) {
        var $a, $b, TMP_11, self = this, model = nil, index_deps = nil;

        if (index['$<'](0)) {
          index = self.$size()['$+'](index)};
        model = self.array.$delete_at(index);
        index_deps = self.array_deps.$delete_at(index);
        if (index_deps !== false && index_deps !== nil) {
          index_deps.$remove()};
        self['$trigger_removed!'](index);
        ($a = ($b = index).$upto, $a._p = (TMP_11 = function(position){var self = TMP_11._s || this;
if (position == null) position = nil;
        return self['$trigger_for_index!'](position)}, TMP_11._s = self, TMP_11), $a).call($b, self.$size()['$+'](1));
        self['$trigger_size_change!']();
        if ((($a = self.persistor) !== nil && (!$a._isBoolean || $a == true))) {
          self.persistor.$removed(model)};
        return model;
      };

      def.$delete = function(val) {
        var $a, self = this, index = nil;

        index = self.array.$index(val);
        if (index !== false && index !== nil) {
          return self.$delete_at(index)
        } else if ((($a = self.persistor) !== nil && (!$a._isBoolean || $a == true))) {
          return self.persistor.$removed(val)
          } else {
          return nil
        };
      };

      def.$clear = function() {
        var $a, $b, TMP_12, $c, TMP_13, self = this, old_size = nil, deps = nil;

        old_size = self.array.$size();
        deps = self.array_deps;
        self.array_deps = [];
        ($a = ($b = old_size).$times, $a._p = (TMP_12 = function(index){var self = TMP_12._s || this;
if (index == null) index = nil;
        return self['$trigger_removed!'](old_size['$-'](index)['$-'](1))}, TMP_12._s = self, TMP_12), $a).call($b);
        if (deps !== false && deps !== nil) {
          ($a = ($c = deps).$each, $a._p = (TMP_13 = function(dep){var self = TMP_13._s || this;
if (dep == null) dep = nil;
          if (dep !== false && dep !== nil) {
              return dep['$changed!']()
              } else {
              return nil
            }}, TMP_13._s = self, TMP_13), $a).call($c)};
        return self.array = [];
      };

      def['$<<'] = function(value) {
        var self = this, result = nil;

        result = (self.array['$<<'](value));
        self['$trigger_for_index!'](self.$size()['$-'](1));
        self['$trigger_added!'](self.$size()['$-'](1));
        self['$trigger_size_change!']();
        return result;
      };

      def['$+'] = function(array) {
        var $a, $b, TMP_14, self = this, old_size = nil, result = nil;

        self.$fail("not implemented yet");
        old_size = self.$size();
        result = (($a = $scope.ReactiveArray) == null ? $opal.cm('ReactiveArray') : $a).$new(self.array.$dup()['$+'](array));
        ($a = ($b = old_size).$upto, $a._p = (TMP_14 = function(index){var self = TMP_14._s || this;
if (index == null) index = nil;
        self['$trigger_for_index!']("changed", index);
          return self['$trigger_added!'](old_size['$+'](index));}, TMP_14._s = self, TMP_14), $a).call($b, result.$size()['$-'](1));
        self['$trigger_size_change!']();
        return result;
      };

      def.$insert = function(index, objects) {
        var $a, $b, $c, TMP_15, $d, TMP_16, self = this, result = nil;

        objects = $slice.call(arguments, 1);
        result = ($a = self.array).$insert.apply($a, [index].concat(objects));
        ($b = ($c = index).$upto, $b._p = (TMP_15 = function(index){var self = TMP_15._s || this;
if (index == null) index = nil;
        return self['$trigger_for_index!'](index)}, TMP_15._s = self, TMP_15), $b).call($c, result.$size());
        ($b = ($d = objects.$size()).$times, $b._p = (TMP_16 = function(count){var self = TMP_16._s || this;
if (count == null) count = nil;
        return self['$trigger_added!'](index['$+'](count))}, TMP_16._s = self, TMP_16), $b).call($d);
        self['$trigger_size_change!']();
        return result;
      };

      def.$inspect = function() {
        var self = this;

        self.size_dep.$depend();
        return "#<" + (self.$class()) + ":" + (self.$object_id()) + " " + (self.array.$inspect()) + ">";
      };

      self.$private();

      def['$trigger_size_change!'] = function() {
        var $a, self = this, new_size = nil;

        new_size = self.array.$size();
        if ((($a = new_size['$=='](self.old_size)['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
          self.old_size = new_size;
          return self.size_dep['$changed!']();
          } else {
          return nil
        };
      };

      def['$trigger_for_index!'] = function(index) {
        var self = this, dep = nil;

        dep = self.array_deps['$[]'](index);
        if (dep !== false && dep !== nil) {
          return dep['$changed!']()
          } else {
          return nil
        };
      };

      def['$trigger_added!'] = function(index) {
        var self = this;

        return self['$trigger!']("added", index);
      };

      return (def['$trigger_removed!'] = function(index) {
        var self = this;

        return self['$trigger!']("removed", index);
      }, nil) && 'trigger_removed!';
    })(self, null)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $gvars = $opal.gvars;

  $opal.add_stubs(['$is_a?', '$to_h', '$to_a', '$event_added', '$event_removed', '$==', '$last', '$camelize', '$singularize', '$[]', '$model_classes']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'ModelHelpers');

      var def = self._proto, $scope = self._scope;

      def.$deep_unwrap = function(value) {
        var $a, $b, self = this;

        if ((($a = value['$is_a?']((($b = $scope.Model) == null ? $opal.cm('Model') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
          return value.$to_h()
        } else if ((($a = value['$is_a?']((($b = $scope.ArrayModel) == null ? $opal.cm('ArrayModel') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
          return value.$to_a()
          } else {
          return value
        };
      };

      def.$event_added = function(event, first, first_for_event) {
        var $a, self = this;
        if (self.persistor == null) self.persistor = nil;

        if ((($a = self.persistor) !== nil && (!$a._isBoolean || $a == true))) {
          return self.persistor.$event_added(event, first, first_for_event)
          } else {
          return nil
        };
      };

      def.$event_removed = function(event, last, last_for_event) {
        var $a, self = this;
        if (self.persistor == null) self.persistor = nil;

        if ((($a = self.persistor) !== nil && (!$a._isBoolean || $a == true))) {
          return self.persistor.$event_removed(event, last, last_for_event)
          } else {
          return nil
        };
      };

      def.$class_at_path = function(path) {
        var $a, $b, self = this, index = nil, klass_name = nil, klass = nil, e = nil;
        if ($gvars.page == null) $gvars.page = nil;

        if (path !== false && path !== nil) {
          try {
          if (path.$last()['$==']("[]")) {
              index = -2
              } else {
              index = -1
            };
            klass_name = path['$[]'](index).$singularize().$camelize();
            klass = ((($a = $gvars.page.$model_classes()['$[]'](klass_name)) !== false && $a !== nil) ? $a : (($b = $scope.Model) == null ? $opal.cm('Model') : $b));
          } catch ($err) {if ($opal.$rescue($err, [(($a = $scope.NameError) == null ? $opal.cm('NameError') : $a)])) {e = $err;
            klass = (($a = $scope.Model) == null ? $opal.cm('Model') : $a)
            }else { throw $err; }
          }
          } else {
          klass = (($a = $scope.Model) == null ? $opal.cm('Model') : $a)
        };
        return klass;
      };
            ;$opal.donate(self, ["$deep_unwrap", "$event_added", "$event_removed", "$class_at_path"]);
    })(self)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module;

  $opal.add_stubs(['$respond_to?', '$state', '$==']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'ModelState');

      var def = self._proto, $scope = self._scope;

      def.$state = function() {
        var $a, $b, self = this;
        if (self.persistor == null) self.persistor = nil;
        if (self.state == null) self.state = nil;

        if ((($a = ($b = self.persistor, $b !== false && $b !== nil ?self.persistor['$respond_to?']("state") : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          return self.persistor.$state()
          } else {
          return ((($a = self.state) !== false && $a !== nil) ? $a : "loaded")
        };
      };

      def.$change_state_to = function(state) {
        var self = this;

        return self.state = state;
      };

      def['$loaded?'] = function() {
        var self = this;

        return self.$state()['$==']("loaded");
      };
            ;$opal.donate(self, ["$state", "$change_state_to", "$loaded?"]);
    })(self)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$include', '$attr_reader', '$each', '$define_method', '$load_data', '$respond_to?', '$send', '$to_proc', '$raise', '$proxy_with_load_data', '$proxy_to_persistor', '$[]', '$setup_persistor', '$wrap_values', '$loaded', '$is_a?', '$options=', '$merge', '$+', '$first', '$added', '$-', '$size', '$resolve', '$new', '$limit', '$find', '$class_at_path', '$options', '$<<', '$deep_unwrap', '$attributes', '$server?', '$==', '$state', '$class', '$reject', '$to_sym', '$private']);
  ;
  ;
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $ArrayModel(){};
      var self = $ArrayModel = $klass($base, $super, 'ArrayModel', $ArrayModel);

      var def = self._proto, $scope = self._scope, $a, TMP_3, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_12;

      def.persistor = def.options = def.array = nil;
      self.$include((($a = $scope.ModelWrapper) == null ? $opal.cm('ModelWrapper') : $a));

      self.$include((($a = $scope.ModelHelpers) == null ? $opal.cm('ModelHelpers') : $a));

      self.$include((($a = $scope.ModelState) == null ? $opal.cm('ModelState') : $a));

      self.$attr_reader("parent", "path", "persistor", "options", "array");

      $opal.defs(self, '$proxy_with_load_data', TMP_3 = function(method_names) {
        var $a, $b, TMP_1, self = this;

        method_names = $slice.call(arguments, 0);
        return ($a = ($b = method_names).$each, $a._p = (TMP_1 = function(method_name){var self = TMP_1._s || this, $a, $b, TMP_2;
if (method_name == null) method_name = nil;
        return ($a = ($b = self).$define_method, $a._p = (TMP_2 = function(args){var self = TMP_2._s || this;
args = $slice.call(arguments, 0);
          self.$load_data();
            return $opal.find_iter_super_dispatcher(self, 'proxy_with_load_data', (TMP_2._def || TMP_1._def || TMP_3), null).apply(self, [].concat(args));}, TMP_2._s = self, TMP_2), $a).call($b, method_name)}, TMP_1._s = self, TMP_1), $a).call($b);
      });

      $opal.defs(self, '$proxy_to_persistor', function(method_names) {
        var $a, $b, TMP_4, self = this;

        method_names = $slice.call(arguments, 0);
        return ($a = ($b = method_names).$each, $a._p = (TMP_4 = function(method_name){var self = TMP_4._s || this, $a, $b, TMP_5;
if (method_name == null) method_name = nil;
        return ($a = ($b = self).$define_method, $a._p = (TMP_5 = function(args){var self = TMP_5._s || this, block, $a, $b;
            if (self.persistor == null) self.persistor = nil;
args = $slice.call(arguments, 0);
            block = TMP_5._p || nil, TMP_5._p = null;
          if ((($a = self.persistor['$respond_to?'](method_name)) !== nil && (!$a._isBoolean || $a == true))) {
              return ($a = ($b = self.persistor).$send, $a._p = block.$to_proc(), $a).apply($b, [method_name].concat(args))
              } else {
              return self.$raise("this model's persistance layer does not support " + (method_name) + ", try using store")
            }}, TMP_5._s = self, TMP_5), $a).call($b, method_name)}, TMP_4._s = self, TMP_4), $a).call($b);
      });

      self.$proxy_with_load_data("[]", "size", "first", "last");

      self.$proxy_to_persistor("find", "skip", "limit", "then");

      def.$initialize = TMP_6 = function(array, options) {
        var $a, self = this, $iter = TMP_6._p, $yield = $iter || nil;

        if (array == null) {
          array = []
        }
        if (options == null) {
          options = $hash2([], {})
        }
        TMP_6._p = null;
        self.options = options;
        self.parent = options['$[]']("parent");
        self.path = ((($a = options['$[]']("path")) !== false && $a !== nil) ? $a : []);
        self.persistor = self.$setup_persistor(options['$[]']("persistor"));
        array = self.$wrap_values(array);
        $opal.find_super_dispatcher(self, 'initialize', TMP_6, null).apply(self, [array]);
        if ((($a = self.persistor) !== nil && (!$a._isBoolean || $a == true))) {
          return self.persistor.$loaded()
          } else {
          return nil
        };
      };

      def.$attributes = function() {
        var self = this;

        return self;
      };

      def['$<<'] = TMP_7 = function(model) {
        var $a, $b, self = this, $iter = TMP_7._p, $yield = $iter || nil;

        TMP_7._p = null;
        self.$load_data();
        if ((($a = model['$is_a?']((($b = $scope.Model) == null ? $opal.cm('Model') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
          model['$options='](self.options.$merge($hash2(["path"], {"path": self.options['$[]']("path")['$+'](["[]"])})))
          } else {
          model = self.$wrap_values([model]).$first()
        };
        $opal.find_super_dispatcher(self, '<<', TMP_7, null).apply(self, [model]);
        if ((($a = self.persistor) !== nil && (!$a._isBoolean || $a == true))) {
          return self.persistor.$added(model, self.array.$size()['$-'](1))
          } else {
          return nil
        };
      };

      def.$append = function(model) {
        var $a, $b, self = this, promise = nil;

        $a = $opal.to_ary(self.$send("<<", model)), promise = ($a[0] == null ? nil : $a[0]), model = ($a[1] == null ? nil : $a[1]);
        ((($a = promise) !== false && $a !== nil) ? $a : promise = (($b = $scope.Promise) == null ? $opal.cm('Promise') : $b).$new().$resolve(model));
        return promise;
      };

      def.$find_one = TMP_8 = function(args) {
        var $a, $b, self = this, $iter = TMP_8._p, block = $iter || nil;

        args = $slice.call(arguments, 0);
        TMP_8._p = null;
        return ($a = ($b = self).$find, $a._p = block.$to_proc(), $a).apply($b, [].concat(args)).$limit(1)['$[]'](0);
      };

      def.$inject = TMP_9 = function(args) {
        var self = this, $iter = TMP_9._p, $yield = $iter || nil;

        args = $slice.call(arguments, 0);
        TMP_9._p = null;
        args = self.$wrap_values(args);
        return $opal.find_super_dispatcher(self, 'inject', TMP_9, null).apply(self, [].concat(args));
      };

      def['$+'] = TMP_10 = function(args) {
        var self = this, $iter = TMP_10._p, $yield = $iter || nil;

        args = $slice.call(arguments, 0);
        TMP_10._p = null;
        args = self.$wrap_values(args);
        return $opal.find_super_dispatcher(self, '+', TMP_10, null).apply(self, [].concat(args));
      };

      def.$new_model = function(args) {
        var $a, self = this;

        args = $slice.call(arguments, 0);
        return ($a = self.$class_at_path(self.$options()['$[]']("path"))).$new.apply($a, [].concat(args));
      };

      def.$new_array_model = function(args) {
        var $a, $b, self = this;

        args = $slice.call(arguments, 0);
        return ($a = (($b = $scope.ArrayModel) == null ? $opal.cm('ArrayModel') : $b)).$new.apply($a, [].concat(args));
      };

      def.$to_a = function() {
        var $a, $b, TMP_11, self = this, array = nil;

        array = [];
        ($a = ($b = self.$attributes()).$each, $a._p = (TMP_11 = function(value){var self = TMP_11._s || this;
if (value == null) value = nil;
        return array['$<<'](self.$deep_unwrap(value))}, TMP_11._s = self, TMP_11), $a).call($b);
        return array;
      };

      def.$inspect = TMP_12 = function() {var $zuper = $slice.call(arguments, 0);
        var $a, $b, $c, $d, $e, self = this, $iter = TMP_12._p, $yield = $iter || nil;

        TMP_12._p = null;
        if ((($a = (($b = $scope.Volt) == null ? $opal.cm('Volt') : $b)['$server?']()) !== nil && (!$a._isBoolean || $a == true))) {
          self.$load_data()};
        if ((($a = ($b = ($c = self.persistor, $c !== false && $c !== nil ?self.persistor['$is_a?']((($d = ((($e = $scope.Persistors) == null ? $opal.cm('Persistors') : $e))._scope).ArrayStore == null ? $d.cm('ArrayStore') : $d.ArrayStore)) : $c), $b !== false && $b !== nil ?self.$state()['$==']("not_loaded") : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          return "#<" + (self.$class()) + ":not loaded, access with [] or size to load>"
          } else {
          return $opal.find_super_dispatcher(self, 'inspect', TMP_12, $iter).apply(self, $zuper)
        };
      };

      def.$buffer = function() {
        var $a, $b, TMP_13, self = this, model_path = nil, model_klass = nil, new_options = nil, model = nil;

        model_path = self.$options()['$[]']("path")['$+'](["[]"]);
        model_klass = self.$class_at_path(model_path);
        new_options = ($a = ($b = self.$options().$merge($hash2(["path", "save_to"], {"path": model_path, "save_to": self}))).$reject, $a._p = (TMP_13 = function(k, _){var self = TMP_13._s || this;
if (k == null) k = nil;if (_ == null) _ = nil;
        return k.$to_sym()['$==']("persistor")}, TMP_13._s = self, TMP_13), $a).call($b);
        model = model_klass.$new($hash2([], {}), new_options);
        return model;
      };

      self.$private();

      def.$setup_persistor = function(persistor) {
        var self = this;

        if (persistor !== false && persistor !== nil) {
          return self.persistor = persistor.$new(self)
          } else {
          return nil
        };
      };

      return (def.$load_data = function() {
        var $a, $b, $c, $d, self = this;

        if ((($a = ($b = self.persistor, $b !== false && $b !== nil ?self.persistor['$is_a?']((($c = ((($d = $scope.Persistors) == null ? $opal.cm('Persistors') : $d))._scope).ArrayStore == null ? $c.cm('ArrayStore') : $c.ArrayStore)) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          return self.persistor.$load_data()
          } else {
          return nil
        };
      }, nil) && 'load_data';
    })(self, (($a = $scope.ReactiveArray) == null ? $opal.cm('ReactiveArray') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $hash2 = $opal.hash2;

  $opal.add_stubs(['$to_sym', '$delete', '$changed!', '$removed', '$depend', '$size', '$each_pair', '$<<', '$nil?', '$!', '$==', '$false?', '$true?', '$each_with_object', '$to_proc', '$each', '$is_a?', '$key?', '$[]=', '$deep_unwrap']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'ModelHashBehaviour');

      var def = self._proto, $scope = self._scope, TMP_3, TMP_4, TMP_6;

      def.$delete = function(name) {
        var $a, self = this, value = nil;
        if (self.attributes == null) self.attributes = nil;
        if (self.size_dep == null) self.size_dep = nil;
        if (self.deps == null) self.deps = nil;
        if (self.persistor == null) self.persistor = nil;

        name = name.$to_sym();
        value = self.attributes.$delete(name);
        self.size_dep['$changed!']();
        self.deps.$delete(name);
        if ((($a = self.persistor) !== nil && (!$a._isBoolean || $a == true))) {
          self.persistor.$removed(name)};
        return value;
      };

      def.$size = function() {
        var self = this;
        if (self.size_dep == null) self.size_dep = nil;
        if (self.attributes == null) self.attributes = nil;

        self.size_dep.$depend();
        return self.attributes.$size();
      };

      def.$keys = function() {
        var $a, $b, TMP_1, self = this, keys = nil;
        if (self.size_dep == null) self.size_dep = nil;

        self.size_dep.$depend();
        keys = [];
        ($a = ($b = self).$each_pair, $a._p = (TMP_1 = function(k, v){var self = TMP_1._s || this;
if (k == null) k = nil;if (v == null) v = nil;
        return keys['$<<'](k)}, TMP_1._s = self, TMP_1), $a).call($b);
        return keys;
      };

      def['$nil?'] = function() {
        var self = this;
        if (self.attributes == null) self.attributes = nil;

        return self.attributes['$nil?']();
      };

      def['$empty?'] = function() {
        var $a, self = this;
        if (self.size_dep == null) self.size_dep = nil;
        if (self.attributes == null) self.attributes = nil;

        self.size_dep.$depend();
        return ((($a = self.attributes['$!']()) !== false && $a !== nil) ? $a : self.attributes.$size()['$=='](0));
      };

      def['$false?'] = function() {
        var self = this;
        if (self.attributes == null) self.attributes = nil;

        return self.attributes['$false?']();
      };

      def['$true?'] = function() {
        var self = this;
        if (self.attributes == null) self.attributes = nil;

        return self.attributes['$true?']();
      };

      def.$clear = function() {
        var $a, $b, TMP_2, self = this;
        if (self.attributes == null) self.attributes = nil;
        if (self.size_dep == null) self.size_dep = nil;

        ($a = ($b = self.attributes).$each_pair, $a._p = (TMP_2 = function(key, _){var self = TMP_2._s || this;
if (key == null) key = nil;if (_ == null) _ = nil;
        return self.$delete(key)}, TMP_2._s = self, TMP_2), $a).call($b);
        return self.size_dep['$changed!']();
      };

      def.$each_with_object = TMP_3 = function(args) {
        var $a, $b, $c, self = this, $iter = TMP_3._p, block = $iter || nil;
        if (self.attributes == null) self.attributes = nil;

        args = $slice.call(arguments, 0);
        TMP_3._p = null;
        return ($a = ($b = (((($c = self.attributes) !== false && $c !== nil) ? $c : $hash2([], {})))).$each_with_object, $a._p = block.$to_proc(), $a).apply($b, [].concat(args));
      };

      def.$each = TMP_4 = function() {
        var $a, $b, self = this, $iter = TMP_4._p, block = $iter || nil;
        if (self.array == null) self.array = nil;

        TMP_4._p = null;
        self.$size();
        return ($a = ($b = self.array).$each, $a._p = block.$to_proc(), $a).call($b);
      };

      def.$each_pair = TMP_6 = function() {
        var $a, $b, TMP_5, self = this, $iter = TMP_6._p, $yield = $iter || nil;
        if (self.attributes == null) self.attributes = nil;

        TMP_6._p = null;
        return ($a = ($b = self.attributes).$each_pair, $a._p = (TMP_5 = function(k, v){var self = TMP_5._s || this, $a, $b, $c;
if (k == null) k = nil;if (v == null) v = nil;
        if ((($a = ($b = v['$is_a?']((($c = $scope.Model) == null ? $opal.cm('Model') : $c)), $b !== false && $b !== nil ?v['$nil?']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            return nil
            } else {
            return $a = $opal.$yieldX($yield, [k, v]), $a === $breaker ? $a : $a
          }}, TMP_5._s = self, TMP_5), $a).call($b);
      };

      def['$key?'] = function(key) {
        var $a, self = this;
        if (self.attributes == null) self.attributes = nil;

        return ($a = self.attributes, $a !== false && $a !== nil ?self.attributes['$key?'](key) : $a);
      };

      def.$to_h = function() {
        var $a, $b, TMP_7, self = this, hash = nil;
        if (self.size_dep == null) self.size_dep = nil;
        if (self.attributes == null) self.attributes = nil;

        self.size_dep.$depend();
        if ((($a = self.attributes['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
          return nil
          } else {
          hash = $hash2([], {});
          ($a = ($b = self.attributes).$each_pair, $a._p = (TMP_7 = function(key, value){var self = TMP_7._s || this;
if (key == null) key = nil;if (value == null) value = nil;
          return hash['$[]='](key, self.$deep_unwrap(value))}, TMP_7._s = self, TMP_7), $a).call($b);
          return hash;
        };
      };
            ;$opal.donate(self, ["$delete", "$size", "$keys", "$nil?", "$empty?", "$false?", "$true?", "$clear", "$each_with_object", "$each", "$each_pair", "$key?", "$to_h"]);
    })(self)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$read_attribute', '$is_a?', '$[]', '$fail', '$!', '$<', '$size', '$[]=', '$>']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $LengthValidator(){};
      var self = $LengthValidator = $klass($base, $super, 'LengthValidator', $LengthValidator);

      var def = self._proto, $scope = self._scope;

      return ($opal.defs(self, '$validate', function(model, old_model, field_name, args) {
        var $a, $b, self = this, errors = nil, value = nil, min = nil, max = nil, message = nil;

        errors = $hash2([], {});
        value = model.$read_attribute(field_name);
        if ((($a = args['$is_a?']((($b = $scope.Fixnum) == null ? $opal.cm('Fixnum') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
          min = args;
          max = nil;
          message = nil;
        } else if ((($a = args['$is_a?']((($b = $scope.Hash) == null ? $opal.cm('Hash') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
          min = ((($a = args['$[]']("length")) !== false && $a !== nil) ? $a : args['$[]']("minimum"));
          max = args['$[]']("maximum");
          if ((($a = min['$is_a?']((($b = $scope.Fixnum) == null ? $opal.cm('Fixnum') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            self.$fail("length or minimum must be specified")
          };
          message = args['$[]']("message");
          } else {
          self.$fail("The arguments to length must be a number or a hash")
        };
        if ((($a = ((($b = value['$!']()) !== false && $b !== nil) ? $b : value.$size()['$<'](min))) !== nil && (!$a._isBoolean || $a == true))) {
          errors['$[]='](field_name, [((($a = message) !== false && $a !== nil) ? $a : "must be at least " + (args) + " characters")])
        } else if ((($a = (($b = max !== false && max !== nil) ? value.$size()['$>'](max) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          errors['$[]='](field_name, [((($a = message) !== false && $a !== nil) ? $a : "must be less than " + (args) + " characters")])};
        return errors;
      }), nil) && 'validate'
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$read_attribute', '$!', '$blank?', '$is_a?', '$[]', '$[]=']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $PresenceValidator(){};
      var self = $PresenceValidator = $klass($base, $super, 'PresenceValidator', $PresenceValidator);

      var def = self._proto, $scope = self._scope;

      return ($opal.defs(self, '$validate', function(model, old_model, field_name, args) {
        var $a, $b, $c, self = this, errors = nil, value = nil, message = nil;

        errors = $hash2([], {});
        value = model.$read_attribute(field_name);
        if ((($a = ((($b = value['$!']()) !== false && $b !== nil) ? $b : value['$blank?']())) !== nil && (!$a._isBoolean || $a == true))) {
          if ((($a = ($b = args['$is_a?']((($c = $scope.Hash) == null ? $opal.cm('Hash') : $c)), $b !== false && $b !== nil ?args['$[]']("message") : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            message = args['$[]']("message")
            } else {
            message = "must be specified"
          };
          errors['$[]='](field_name, [message]);};
        return errors;
      }), nil) && 'validate'
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2, $gvars = $opal.gvars;

  $opal.add_stubs(['$!', '$==', '$read_attribute', '$[]=', '$to_s', '$_id', '$>', '$size', '$find', '$send', '$store', '$[]', '$path', '$is_a?']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $UniqueValidator(){};
      var self = $UniqueValidator = $klass($base, $super, 'UniqueValidator', $UniqueValidator);

      var def = self._proto, $scope = self._scope;

      return ($opal.defs(self, '$validate', function(model, old_model, field_name, args) {
        var $a, $b, $c, self = this, errors = nil, value = nil, query = nil, message = nil;
        if ($gvars.page == null) $gvars.page = nil;

        errors = $hash2([], {});
        if ((($a = (($b = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $b)['$==']("opal")['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
          if (args !== false && args !== nil) {
            value = model.$read_attribute(field_name);
            query = $hash2([], {});
            query['$[]='](field_name.$to_s(), value);
            query['$[]=']("_id", $hash2(["$ne"], {"$ne": model.$_id()}));
            if ($gvars.page.$store().$send(("_" + model.$path()['$[]'](-2).$to_s())).$find(query).$size()['$>'](0)) {
              message = ((($a = (($b = args['$is_a?']((($c = $scope.Hash) == null ? $opal.cm('Hash') : $c)), $b !== false && $b !== nil ?args['$[]']("message") : $b))) !== false && $a !== nil) ? $a : "is already taken");
              errors['$[]='](field_name, [message]);};}};
        return errors;
      }), nil) && 'validate'
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$errors', '$new', '$attr_reader', '$read_attribute', '$Float', '$check_errors', '$[]', '$[]=', '$<<', '$is_a?', '$each', '$===', '$<', '$add_error', '$>']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $NumericalityValidator(){};
      var self = $NumericalityValidator = $klass($base, $super, 'NumericalityValidator', $NumericalityValidator);

      var def = self._proto, $scope = self._scope;

      def.value = def.field_name = def.errors = def.args = nil;
      $opal.defs(self, '$validate', function(model, old_model, field_name, args) {
        var self = this;

        return self.$new(model, field_name, args).$errors();
      });

      self.$attr_reader("errors");

      def.$initialize = function(model, field_name, args) {
        var $a, self = this;

        self.field_name = field_name;
        self.args = args;
        self.errors = $hash2([], {});
        self.value = model.$read_attribute(field_name);
        self.value = (function() {try {return (($a = $scope.Kernel) == null ? $opal.cm('Kernel') : $a).$Float(self.value) } catch ($err) { return nil }})();
        return self.$check_errors();
      };

      def.$add_error = function(error) {
        var $a, $b, $c, self = this, field_errors = nil;

        field_errors = (($a = self.field_name, $b = self.errors, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, []))));
        return field_errors['$<<'](error);
      };

      return (def.$check_errors = function() {
        var $a, $b, $c, TMP_1, $d, self = this, message = nil;

        if ((($a = ($b = self.value, $b !== false && $b !== nil ?self.value['$is_a?']((($c = $scope.Numeric) == null ? $opal.cm('Numeric') : $c)) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          if ((($a = self.args['$is_a?']((($b = $scope.Hash) == null ? $opal.cm('Hash') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            return ($a = ($b = self.args).$each, $a._p = (TMP_1 = function(arg, val){var self = TMP_1._s || this, $case = nil;
              if (self.value == null) self.value = nil;
if (arg == null) arg = nil;if (val == null) val = nil;
            return (function() {$case = arg;if ("min"['$===']($case)) {if (self.value['$<'](val)) {
                return self.$add_error("number must be greater than " + (val))
                } else {
                return nil
              }}else if ("max"['$===']($case)) {if (self.value['$>'](val)) {
                return self.$add_error("number must be less than " + (val))
                } else {
                return nil
              }}else { return nil }})()}, TMP_1._s = self, TMP_1), $a).call($b)
            } else {
            return nil
          }
          } else {
          message = ((($a = (($c = self.args['$is_a?']((($d = $scope.Hash) == null ? $opal.cm('Hash') : $d)), $c !== false && $c !== nil ?self.args['$[]']("message") : $c))) !== false && $a !== nil) ? $a : "must be a number");
          return self.$add_error(message);
        };
      }, nil) && 'check_errors';
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $hash2 = $opal.hash2;

  $opal.add_stubs(['$raise', '$custom_validations', '$custom_validations=', '$<<', '$validations', '$validations=', '$[]=', '$send', '$class_attribute', '$marked_fields', '$new', '$class', '$each_key', '$mark_field!', '$to_sym', '$errors', '$delete', '$proc', '$merge!', '$+', '$[]', '$options', '$is_a?', '$run_validations', '$client?', '$call', '$to_h', '$server_errors', '$run_custom_validations', '$private', '$each_pair', '$!', '$validation_class', '$validate_with', '$fail', '$each', '$instance_exec', '$to_proc', '$validate', '$const_get', '$to_s', '$camelize', '$puts']);
  ;
  ;
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'Validations');

      var def = self._proto, $scope = self._scope;

      (function($base) {
        var self = $module($base, 'ClassMethods');

        var def = self._proto, $scope = self._scope, TMP_1;

        def.$validate = TMP_1 = function(field_name, options) {
          var $a, $b, self = this, $iter = TMP_1._p, block = $iter || nil;

          if (field_name == null) {
            field_name = nil
          }
          if (options == null) {
            options = nil
          }
          TMP_1._p = null;
          if (block !== false && block !== nil) {
            if ((($a = ((($b = field_name) !== false && $b !== nil) ? $b : options)) !== nil && (!$a._isBoolean || $a == true))) {
              self.$raise("validate should be passed a field name and options or a block, not both.")};
            ($a = self, ((($b = $a.$custom_validations()) !== false && $b !== nil) ? $b : $a['$custom_validations=']([])));
            return self.$custom_validations()['$<<'](block);
            } else {
            ($a = self, ((($b = $a.$validations()) !== false && $b !== nil) ? $b : $a['$validations=']($hash2([], {}))));
            return self.$validations()['$[]='](field_name, options);
          };
        }
                ;$opal.donate(self, ["$validate"]);
      })(self);

      $opal.defs(self, '$included', function(base) {
        var $a, self = this;

        base.$send("extend", (($a = $scope.ClassMethods) == null ? $opal.cm('ClassMethods') : $a));
        return base.$class_attribute("custom_validations", "validations");
      });

      def['$mark_field!'] = function(field_name) {
        var self = this;

        return self.$marked_fields()['$[]='](field_name, true);
      };

      def.$marked_fields = function() {
        var $a, $b, self = this;
        if (self.marked_fields == null) self.marked_fields = nil;

        return ((($a = self.marked_fields) !== false && $a !== nil) ? $a : self.marked_fields = (($b = $scope.ReactiveHash) == null ? $opal.cm('ReactiveHash') : $b).$new());
      };

      def['$mark_all_fields!'] = function() {
        var $a, $b, TMP_2, self = this, validations = nil;

        validations = self.$class().$validations();
        if (validations !== false && validations !== nil) {
          return ($a = ($b = validations).$each_key, $a._p = (TMP_2 = function(key){var self = TMP_2._s || this;
if (key == null) key = nil;
          return self['$mark_field!'](key.$to_sym())}, TMP_2._s = self, TMP_2), $a).call($b)
          } else {
          return nil
        };
      };

      def.$marked_errors = function() {
        var self = this;

        return self.$errors(true);
      };

      def.$server_errors = function() {
        var $a, $b, self = this;
        if (self.server_errors == null) self.server_errors = nil;

        return ((($a = self.server_errors) !== false && $a !== nil) ? $a : self.server_errors = (($b = $scope.ReactiveHash) == null ? $opal.cm('ReactiveHash') : $b).$new());
      };

      def.$clear_server_errors = function(key) {
        var self = this;
        if (self.server_errors == null) self.server_errors = nil;

        return self.server_errors.$delete(key);
      };

      def.$errors = function(marked_only) {
        var $a, $b, TMP_3, $c, $d, $e, self = this, errors = nil, merge = nil, save_to = nil, old_model = nil;

        if (marked_only == null) {
          marked_only = false
        }
        errors = $hash2([], {});
        merge = ($a = ($b = self).$proc, $a._p = (TMP_3 = function(new_errors){var self = TMP_3._s || this, $a, $b, TMP_4;
if (new_errors == null) new_errors = nil;
        return ($a = ($b = errors)['$merge!'], $a._p = (TMP_4 = function(key, new_val, old_val){var self = TMP_4._s || this;
if (key == null) key = nil;if (new_val == null) new_val = nil;if (old_val == null) old_val = nil;
          return new_val['$+'](old_val)}, TMP_4._s = self, TMP_4), $a).call($b, new_errors)}, TMP_3._s = self, TMP_3), $a).call($b);
        save_to = self.$options()['$[]']("save_to");
        if ((($a = (($c = save_to !== false && save_to !== nil) ? save_to['$is_a?']((($d = ((($e = $scope.Volt) == null ? $opal.cm('Volt') : $e))._scope).Model == null ? $d.cm('Model') : $d.Model)) : $c)) !== nil && (!$a._isBoolean || $a == true))) {
          old_model = save_to
          } else {
          old_model = nil
        };
        errors = self.$run_validations(errors, merge, marked_only, old_model);
        if ((($a = (($c = $scope.Volt) == null ? $opal.cm('Volt') : $c)['$client?']()) !== nil && (!$a._isBoolean || $a == true))) {
          errors = merge.$call(self.$server_errors().$to_h())};
        errors = self.$run_custom_validations(errors, merge, old_model);
        return errors;
      };

      self.$private();

      def.$run_validations = function(errors, merge, marked_only, old_model) {
        var $a, $b, TMP_5, self = this, validations = nil;

        validations = self.$class().$validations();
        if (validations !== false && validations !== nil) {
          ($a = ($b = validations).$each_pair, $a._p = (TMP_5 = function(field_name, options){var self = TMP_5._s || this, $a, $b, TMP_6;
if (field_name == null) field_name = nil;if (options == null) options = nil;
          if ((($a = (($b = marked_only !== false && marked_only !== nil) ? self.$marked_fields()['$[]'](field_name)['$!']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
              return nil;};
            return ($a = ($b = options).$each_pair, $a._p = (TMP_6 = function(validation, args){var self = TMP_6._s || this, klass = nil;
if (validation == null) validation = nil;if (args == null) args = nil;
            klass = self.$validation_class(validation, args);
              if (klass !== false && klass !== nil) {
                return self.$validate_with(merge, klass, old_model, field_name, args)
                } else {
                return self.$fail("validation type " + (validation) + " is not specified.")
              };}, TMP_6._s = self, TMP_6), $a).call($b);}, TMP_5._s = self, TMP_5), $a).call($b)};
        return errors;
      };

      def.$run_custom_validations = function(errors, merge, old_model) {
        var $a, $b, TMP_7, self = this, custom_validations = nil;

        custom_validations = self.$class().$custom_validations();
        if (custom_validations !== false && custom_validations !== nil) {
          ($a = ($b = custom_validations).$each, $a._p = (TMP_7 = function(custom_validation){var self = TMP_7._s || this, $a, $b, result = nil;
if (custom_validation == null) custom_validation = nil;
          result = ($a = ($b = self).$instance_exec, $a._p = custom_validation.$to_proc(), $a).call($b, old_model);
            if (result !== false && result !== nil) {
              return errors = merge.$call(result)
              } else {
              return nil
            };}, TMP_7._s = self, TMP_7), $a).call($b)};
        return errors;
      };

      def.$validate_with = function(merge, klass, old_model, field_name, args) {
        var self = this;

        return merge.$call(klass.$validate(self, old_model, field_name, args));
      };

      def.$validation_class = function(validation, args) {
        var $a, self = this, e = nil;

        try {
        return (($a = $scope.Volt) == null ? $opal.cm('Volt') : $a).$const_get(("" + validation.$camelize().$to_s() + "Validator"))
        } catch ($err) {if ($opal.$rescue($err, [(($a = $scope.NameError) == null ? $opal.cm('NameError') : $a)])) {e = $err;
          return self.$puts("Unable to find " + (validation) + " validator")
          }else { throw $err; }
        };
      };
            ;$opal.donate(self, ["$mark_field!", "$marked_fields", "$mark_all_fields!", "$marked_errors", "$server_errors", "$clear_server_errors", "$errors", "$run_validations", "$run_custom_validations", "$validate_with", "$validation_class"]);
    })(self)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $hash2 = $opal.hash2;

  $opal.add_stubs(['$errors', '$==', '$size', '$[]', '$options', '$is_a?', '$append', '$attributes', '$assign_attributes', '$fail', '$replace', '$server_errors', '$promise_for_errors', '$then', '$[]=', '$_id', '$mark_all_fields!', '$reject', '$new', '$plural?', '$last', '$!', '$class_at_path', '$+', '$to_sym', '$merge', '$state', '$setup_buffer', '$parent']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'Buffer');

      var def = self._proto, $scope = self._scope;

      def['$save!'] = function() {
        var $a, $b, TMP_1, $c, $d, TMP_2, self = this, errors = nil, save_to = nil, promise = nil;

        errors = self.$errors();
        if (errors.$size()['$=='](0)) {
          save_to = self.$options()['$[]']("save_to");
          if (save_to !== false && save_to !== nil) {
            if ((($a = save_to['$is_a?']((($b = $scope.ArrayModel) == null ? $opal.cm('ArrayModel') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
              promise = save_to.$append(self.$attributes())
              } else {
              promise = save_to.$assign_attributes(self.$attributes())
            };
            return ($a = ($b = ($c = ($d = promise).$then, $c._p = (TMP_2 = function(new_model){var self = TMP_2._s || this;
if (new_model == null) new_model = nil;
            if (new_model !== false && new_model !== nil) {
                self.$attributes()['$[]=']("_id", new_model.$_id());
                self.$options()['$[]=']("save_to", new_model);};
              return nil;}, TMP_2._s = self, TMP_2), $c).call($d)).$fail, $a._p = (TMP_1 = function(errors){var self = TMP_1._s || this, $a, $b;
if (errors == null) errors = nil;
            if ((($a = errors['$is_a?']((($b = $scope.Hash) == null ? $opal.cm('Hash') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
                self.$server_errors().$replace(errors)};
              return self.$promise_for_errors(errors);}, TMP_1._s = self, TMP_1), $a).call($b);
            } else {
            return self.$fail("Model is not a buffer, can not be saved, modifications should be persisted as they are made.")
          };
          } else {
          return self.$promise_for_errors(errors)
        };
      };

      def.$promise_for_errors = function(errors) {
        var $a, self = this;

        self['$mark_all_fields!']();
        return (($a = $scope.Promise) == null ? $opal.cm('Promise') : $a).$new().$reject(errors);
      };

      def.$buffer = function() {
        var $a, $b, TMP_3, $c, TMP_4, self = this, model_path = nil, model_klass = nil, new_options = nil, model = nil;

        model_path = self.$options()['$[]']("path");
        if ((($a = ($b = model_path.$last()['$plural?'](), $b !== false && $b !== nil ?model_path['$[]'](-1)['$==']("[]")['$!']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          model_klass = self.$class_at_path(model_path['$+'](["[]"]))
          } else {
          model_klass = self.$class_at_path(model_path)
        };
        new_options = ($a = ($b = self.$options().$merge($hash2(["path", "save_to"], {"path": model_path, "save_to": self}))).$reject, $a._p = (TMP_3 = function(k, _){var self = TMP_3._s || this;
if (k == null) k = nil;if (_ == null) _ = nil;
        return k.$to_sym()['$==']("persistor")}, TMP_3._s = self, TMP_3), $a).call($b);
        model = model_klass.$new($hash2([], {}), new_options, "loading");
        if (self.$state()['$==']("loaded")) {
          self.$setup_buffer(model)
          } else {
          ($a = ($c = self.$parent()).$then, $a._p = (TMP_4 = function(){var self = TMP_4._s || this;

          return self.$setup_buffer(model)}, TMP_4._s = self, TMP_4), $a).call($c)
        };
        return model;
      };
            ;$opal.donate(self, ["$save!", "$promise_for_errors", "$buffer"]);
    })(self)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$!', '$include?', '$raise', '$define_method', '$read_attribute', '$==', '$to_s', '$to_f', '$assign_attribute', '$send']);
  return (function($base) {
    var self = $module($base, 'FieldHelpers');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $InvalidFieldClass(){};
      var self = $InvalidFieldClass = $klass($base, $super, 'InvalidFieldClass', $InvalidFieldClass);

      var def = self._proto, $scope = self._scope;

      return nil;
    })(self, (($a = $scope.RuntimeError) == null ? $opal.cm('RuntimeError') : $a));

    (function($base) {
      var self = $module($base, 'ClassMethods');

      var def = self._proto, $scope = self._scope;

      def.$field = function(name, klass) {
        var $a, $b, $c, TMP_1, TMP_2, self = this;

        if (klass == null) {
          klass = nil
        }
        if ((($a = (($b = klass !== false && klass !== nil) ? [(($c = $scope.String) == null ? $opal.cm('String') : $c), (($c = $scope.Numeric) == null ? $opal.cm('Numeric') : $c)]['$include?'](klass)['$!']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          self.$raise((($a = ((($b = $scope.FieldHelpers) == null ? $opal.cm('FieldHelpers') : $b))._scope).InvalidFieldClass == null ? $a.cm('InvalidFieldClass') : $a.InvalidFieldClass), "valid field types is currently limited to String or Numeric")};
        ($a = ($b = self).$define_method, $a._p = (TMP_1 = function(){var self = TMP_1._s || this;

        return self.$read_attribute(name)}, TMP_1._s = self, TMP_1), $a).call($b, name);
        return ($a = ($c = self).$define_method, $a._p = (TMP_2 = function(val){var self = TMP_2._s || this, $a;
if (val == null) val = nil;
        if (klass !== false && klass !== nil) {
            if (klass['$==']((($a = $scope.String) == null ? $opal.cm('String') : $a))) {
              val = val.$to_s()
            } else if (klass['$==']((($a = $scope.Numeric) == null ? $opal.cm('Numeric') : $a))) {
              val = val.$to_f()}};
          return self.$assign_attribute(name, val);}, TMP_2._s = self, TMP_2), $a).call($c, ("" + name.$to_s() + "="));
      }
            ;$opal.donate(self, ["$field"]);
    })(self);

    $opal.defs(self, '$included', function(base) {
      var $a, self = this;

      return base.$send("extend", (($a = $scope.ClassMethods) == null ? $opal.cm('ClassMethods') : $a));
    });
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$depend', '$ensure_key', '$changed!', '$delete', '$remove', '$each_pair', '$private', '$[]', '$[]=', '$new']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $HashDependency(){};
      var self = $HashDependency = $klass($base, $super, 'HashDependency', $HashDependency);

      var def = self._proto, $scope = self._scope;

      def.hash_depedencies = nil;
      def.$initialize = function() {
        var self = this;

        return self.hash_depedencies = $hash2([], {});
      };

      def.$depend = function(key) {
        var self = this;

        return self.$ensure_key(key).$depend();
      };

      def['$changed!'] = function(key) {
        var self = this;

        return self.$ensure_key(key)['$changed!']();
      };

      def.$delete = function(key) {
        var self = this, dep = nil;

        dep = self.hash_depedencies.$delete(key);
        if (dep !== false && dep !== nil) {
          dep['$changed!']();
          return dep.$remove();
          } else {
          return nil
        };
      };

      def['$changed_all!'] = function() {
        var $a, $b, TMP_1, self = this;

        return ($a = ($b = self.hash_depedencies).$each_pair, $a._p = (TMP_1 = function(key, value){var self = TMP_1._s || this;
if (key == null) key = nil;if (value == null) value = nil;
        return value['$changed!']()}, TMP_1._s = self, TMP_1), $a).call($b);
      };

      self.$private();

      return (def.$ensure_key = function(key) {
        var $a, $b, $c, $d, self = this;

        return ($a = key, $b = self.hash_depedencies, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, (($d = $scope.Dependency) == null ? $opal.cm('Dependency') : $d).$new())));
      }, nil) && 'ensure_key';
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$new', '$depend', '$==', '$send', '$to_proc', '$[]', '$changed!', '$[]=', '$delete', '$each_pair', '$clear', '$inspect']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $ReactiveHash(){};
      var self = $ReactiveHash = $klass($base, $super, 'ReactiveHash', $ReactiveHash);

      var def = self._proto, $scope = self._scope, TMP_1;

      def.all_deps = def.hash = def.deps = nil;
      def.$initialize = function(values) {
        var $a, self = this;

        if (values == null) {
          values = $hash2([], {})
        }
        self.hash = values;
        self.deps = (($a = $scope.HashDependency) == null ? $opal.cm('HashDependency') : $a).$new();
        return self.all_deps = (($a = $scope.Dependency) == null ? $opal.cm('Dependency') : $a).$new();
      };

      def['$=='] = function(val) {
        var self = this;

        self.all_deps.$depend();
        return self.hash['$=='](val);
      };

      def.$method_missing = TMP_1 = function(method_name, args) {
        var $a, $b, self = this, $iter = TMP_1._p, block = $iter || nil;

        args = $slice.call(arguments, 1);
        TMP_1._p = null;
        self.all_deps.$depend();
        return ($a = ($b = self.hash).$send, $a._p = block.$to_proc(), $a).apply($b, [method_name].concat(args));
      };

      def['$[]'] = function(key) {
        var self = this;

        self.deps.$depend(key);
        return self.hash['$[]'](key);
      };

      def['$[]='] = function(key, value) {
        var self = this;

        self.deps['$changed!'](key);
        self.all_deps['$changed!']();
        return self.hash['$[]='](key, value);
      };

      def.$delete = function(key) {
        var self = this;

        self.deps.$delete(key);
        self.all_deps['$changed!']();
        return self.hash.$delete(key);
      };

      def.$clear = function() {
        var $a, $b, TMP_2, self = this;

        ($a = ($b = self.hash).$each_pair, $a._p = (TMP_2 = function(key, _){var self = TMP_2._s || this;
if (key == null) key = nil;if (_ == null) _ = nil;
        return self.$delete(key)}, TMP_2._s = self, TMP_2), $a).call($b);
        return self.all_deps['$changed!']();
      };

      def.$replace = function(hash) {
        var $a, $b, TMP_3, self = this;

        self.$clear();
        return ($a = ($b = hash).$each_pair, $a._p = (TMP_3 = function(key, value){var self = TMP_3._s || this;
if (key == null) key = nil;if (value == null) value = nil;
        return self['$[]='](key, value)}, TMP_3._s = self, TMP_3), $a).call($b);
      };

      def.$to_h = function() {
        var self = this;

        self.all_deps.$depend();
        return self.hash;
      };

      return (def.$inspect = function() {
        var self = this;

        self.all_deps.$depend();
        return "#<ReactiveHash " + (self.hash.$inspect()) + ">";
      }, nil) && 'inspect';
    })(self, null)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2, $range = $opal.range;

  $opal.add_stubs(['$include', '$attr_reader', '$new', '$options=', '$send', '$loaded', '$[]', '$__id=', '$setup_persistor', '$wrap_values', '$delete', '$nosave', '$_id=', '$each_pair', '$respond_to?', '$to_s', '$changed_all!', '$changed', '$alias_method', '$is_a?', '$==', '$attributes', '$!', '$assign_attribute', '$to_proc', '$read_attribute', '$expand!', '$to_sym', '$wrap_value', '$[]=', '$changed!', '$clear_server_errors', '$current', '$key?', '$depend', '$read_new_model', '$in_browser?', '$merge', '$+', '$path', '$plural?', '$new_array_model', '$new_model', '$class_at_path', '$dup', '$nil?', '$last', '$fail', '$<<', '$class', '$object_id', '$inspect', '$private', '$attributes=', '$change_state_to']);
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $NilMethodCall(){};
      var self = $NilMethodCall = $klass($base, $super, 'NilMethodCall', $NilMethodCall);

      var def = self._proto, $scope = self._scope;

      return nil;
    })(self, (($a = $scope.NoMethodError) == null ? $opal.cm('NoMethodError') : $a));

    (function($base, $super) {
      function $Model(){};
      var self = $Model = $klass($base, $super, 'Model', $Model);

      var def = self._proto, $scope = self._scope, $a, TMP_3, TMP_4, TMP_5, TMP_6;

      def.persistor = def.attributes = def.deps = def.size_dep = def.server_errors = def.options = def.parent = def.path = nil;
      self.$include((($a = $scope.ModelWrapper) == null ? $opal.cm('ModelWrapper') : $a));

      self.$include((($a = $scope.ModelHelpers) == null ? $opal.cm('ModelHelpers') : $a));

      self.$include((($a = $scope.ModelHashBehaviour) == null ? $opal.cm('ModelHashBehaviour') : $a));

      self.$include((($a = $scope.Validations) == null ? $opal.cm('Validations') : $a));

      self.$include((($a = $scope.ModelState) == null ? $opal.cm('ModelState') : $a));

      self.$include((($a = $scope.Buffer) == null ? $opal.cm('Buffer') : $a));

      self.$include((($a = $scope.FieldHelpers) == null ? $opal.cm('FieldHelpers') : $a));

      self.$attr_reader("attributes");

      self.$attr_reader("parent", "path", "persistor", "options");

      def.$initialize = function(attributes, options, initial_state) {
        var $a, self = this;

        if (attributes == null) {
          attributes = $hash2([], {})
        }
        if (options == null) {
          options = $hash2([], {})
        }
        if (initial_state == null) {
          initial_state = nil
        }
        self.deps = (($a = $scope.HashDependency) == null ? $opal.cm('HashDependency') : $a).$new();
        self.size_dep = (($a = $scope.Dependency) == null ? $opal.cm('Dependency') : $a).$new();
        self['$options='](options);
        self.$send("attributes=", attributes, true);
        self.state = "loaded";
        if ((($a = self.persistor) !== nil && (!$a._isBoolean || $a == true))) {
          return self.persistor.$loaded(initial_state)
          } else {
          return nil
        };
      };

      def.$_id = function() {
        var $a, self = this;

        return ($a = self.attributes, $a !== false && $a !== nil ?self.attributes['$[]']("_id") : $a);
      };

      def['$_id='] = function(val) {
        var self = this;

        return self['$__id='](val);
      };

      def['$options='] = function(options) {
        var $a, self = this;

        self.options = options;
        self.parent = options['$[]']("parent");
        self.path = ((($a = options['$[]']("path")) !== false && $a !== nil) ? $a : []);
        self.class_paths = options['$[]']("class_paths");
        return self.persistor = self.$setup_persistor(options['$[]']("persistor"));
      };

      def['$attributes='] = function(attrs, initial_setup) {
        var $a, $b, TMP_1, $c, self = this, id = nil;

        if (initial_setup == null) {
          initial_setup = false
        }
        self.attributes = $hash2([], {});
        attrs = self.$wrap_values(attrs);
        if (attrs !== false && attrs !== nil) {
          id = attrs.$delete("_id");
          ($a = ($b = (($c = $scope.Model) == null ? $opal.cm('Model') : $c)).$nosave, $a._p = (TMP_1 = function(){var self = TMP_1._s || this, $a, $b, TMP_2;

          if (id !== false && id !== nil) {
              self['$_id='](id)};
            return ($a = ($b = attrs).$each_pair, $a._p = (TMP_2 = function(key, value){var self = TMP_2._s || this, $a;
if (key == null) key = nil;if (value == null) value = nil;
            if ((($a = self['$respond_to?'](("" + key.$to_s() + "="))) !== nil && (!$a._isBoolean || $a == true))) {
                return self.$send(("" + key.$to_s() + "="), value)
                } else {
                return self.$send(("_" + key.$to_s() + "="), value)
              }}, TMP_2._s = self, TMP_2), $a).call($b);}, TMP_1._s = self, TMP_1), $a).call($b);
          } else {
          self.attributes = attrs
        };
        self.deps['$changed_all!']();
        self.deps = (($a = $scope.HashDependency) == null ? $opal.cm('HashDependency') : $a).$new();
        if (initial_setup !== false && initial_setup !== nil) {
          return nil
        } else if ((($a = self.persistor) !== nil && (!$a._isBoolean || $a == true))) {
          return self.persistor.$changed()
          } else {
          return nil
        };
      };

      self.$alias_method("assign_attributes", "attributes=");

      def['$=='] = TMP_3 = function(val) {var $zuper = $slice.call(arguments, 0);
        var $a, $b, self = this, $iter = TMP_3._p, $yield = $iter || nil;

        TMP_3._p = null;
        if ((($a = val['$is_a?']((($b = $scope.Model) == null ? $opal.cm('Model') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
          return $opal.find_super_dispatcher(self, '==', TMP_3, $iter).apply(self, $zuper)
          } else {
          return self.$attributes()['$=='](val)
        };
      };

      def['$!'] = function() {
        var self = this;

        return self.$attributes()['$!']();
      };

      def.$method_missing = TMP_4 = function(method_name, args) {var $zuper = $slice.call(arguments, 0);
        var $a, $b, self = this, $iter = TMP_4._p, block = $iter || nil;

        args = $slice.call(arguments, 1);
        TMP_4._p = null;
        if (method_name['$[]'](0)['$==']("_")) {
          method_name = method_name['$[]']($range(1, -1, false));
          if (method_name['$[]'](-1)['$==']("=")) {
            return ($a = ($b = self).$assign_attribute, $a._p = block.$to_proc(), $a).apply($b, [method_name['$[]']($range(0, -2, false))].concat(args))
            } else {
            return self.$read_attribute(method_name)
          };
          } else {
          return $opal.find_super_dispatcher(self, 'method_missing', TMP_4, $iter).apply(self, $zuper)
        };
      };

      def.$assign_attribute = TMP_5 = function(method_name, args) {
        var $a, $b, $c, self = this, $iter = TMP_5._p, block = $iter || nil, attribute_name = nil, value = nil, old_value = nil, new_value = nil;

        args = $slice.call(arguments, 1);
        TMP_5._p = null;
        self['$expand!']();
        attribute_name = method_name.$to_sym();
        value = args['$[]'](0);
        old_value = self.attributes['$[]'](attribute_name);
        new_value = self.$wrap_value(value, [attribute_name]);
        if ((($a = old_value['$=='](new_value)['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
          self.attributes['$[]='](attribute_name, new_value);
          self.deps['$changed!'](attribute_name);
          if ((($a = ((($b = old_value['$=='](nil)) !== false && $b !== nil) ? $b : new_value['$=='](nil))) !== nil && (!$a._isBoolean || $a == true))) {
            self.size_dep['$changed!']()};
          if ((($a = self.server_errors) !== nil && (!$a._isBoolean || $a == true))) {
            self.$clear_server_errors(attribute_name)};
          if ((($a = ((($b = ($scope.Thread != null)['$!']()) !== false && $b !== nil) ? $b : (($c = $scope.Thread) == null ? $opal.cm('Thread') : $c).$current()['$[]']("nosave")['$!']())) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = self.persistor) !== nil && (!$a._isBoolean || $a == true))) {
              return self.persistor.$changed(attribute_name)
              } else {
              return nil
            }
            } else {
            return nil
          };
          } else {
          return nil
        };
      };

      def.$read_attribute = function(attr_name) {
        var $a, $b, self = this, new_model = nil;

        attr_name = attr_name.$to_sym();
        if ((($a = ($b = self.attributes, $b !== false && $b !== nil ?self.attributes['$key?'](attr_name) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          self.deps.$depend(attr_name);
          return self.attributes['$[]'](attr_name);
          } else {
          new_model = self.$read_new_model(attr_name);
          ((($a = self.attributes) !== false && $a !== nil) ? $a : self.attributes = $hash2([], {}));
          self.attributes['$[]='](attr_name, new_model);
          if ((($a = (($b = $scope.Volt) == null ? $opal.cm('Volt') : $b)['$in_browser?']()) !== nil && (!$a._isBoolean || $a == true))) {
            setImmediate(function() {;
            self.size_dep['$changed!']();
            });
            } else {
            self.size_dep['$changed!']()
          };
          self.deps.$depend(attr_name);
          return new_model;
        };
      };

      def.$read_new_model = function(method_name) {
        var $a, $b, self = this, opts = nil;

        if ((($a = ($b = self.persistor, $b !== false && $b !== nil ?self.persistor['$respond_to?']("read_new_model") : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          return self.persistor.$read_new_model(method_name)
          } else {
          opts = self.options.$merge($hash2(["parent", "path"], {"parent": self, "path": self.$path()['$+']([method_name])}));
          if ((($a = method_name['$plural?']()) !== nil && (!$a._isBoolean || $a == true))) {
            return self.$new_array_model([], opts)
            } else {
            return self.$new_model(nil, opts)
          };
        };
      };

      def.$new_model = function(attributes, options) {
        var self = this;

        return self.$class_at_path(options['$[]']("path")).$new(attributes, options);
      };

      def.$new_array_model = function(attributes, options) {
        var $a, self = this;

        options = options.$dup();
        options['$[]=']("query", $hash2([], {}));
        return (($a = $scope.ArrayModel) == null ? $opal.cm('ArrayModel') : $a).$new(attributes, options);
      };

      def['$expand!'] = function() {
        var $a, self = this;

        if ((($a = self.$attributes()['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
          self.attributes = $hash2([], {});
          if ((($a = self.parent) !== nil && (!$a._isBoolean || $a == true))) {
            self.parent['$expand!']();
            return self.parent.$send(("_" + self.path.$last().$to_s() + "="), self);
            } else {
            return nil
          };
          } else {
          return nil
        };
      };

      def['$<<'] = function(value) {
        var $a, self = this, path = nil, result = nil;

        if ((($a = self.parent) !== nil && (!$a._isBoolean || $a == true))) {
          self.parent['$expand!']()
          } else {
          self.$fail("Model data should be stored in sub collections.")
        };
        path = self.path.$last();
        result = self.parent.$send(path);
        if ((($a = result['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
          self.parent.$send(("" + path.$to_s() + "="), self.$new_array_model([], self.options));
          result = self.parent.$send(path);};
        result['$<<'](value);
        return nil;
      };

      def.$inspect = function() {
        var self = this;

        return "<" + (self.$class()) + ":" + (self.$object_id()) + " " + (self.$attributes().$inspect()) + ">";
      };

      if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
        $opal.defs(self, '$nosave', TMP_6 = function() {
          var $a, self = this, $iter = TMP_6._p, $yield = $iter || nil;

          TMP_6._p = null;
          return $a = $opal.$yieldX($yield, []), $a === $breaker ? $a : $a;
        })};

      self.$private();

      def.$setup_buffer = function(model) {
        var self = this;

        model['$attributes='](self.$attributes());
        return model.$change_state_to("loaded");
      };

      return (def.$setup_persistor = function(persistor) {
        var self = this;

        if (persistor !== false && persistor !== nil) {
          return self.persistor = persistor.$new(self)
          } else {
          return nil
        };
      }, nil) && 'setup_persistor';
    })(self, null);
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs([]);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $Cursor(){};
      var self = $Cursor = $klass($base, $super, 'Cursor', $Cursor);

      var def = self._proto, $scope = self._scope;

      return nil;
    })(self, (($a = $scope.ArrayModel) == null ? $opal.cm('ArrayModel') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$is_a?', '$new']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'Persistors');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $StoreFactory(){};
        var self = $StoreFactory = $klass($base, $super, 'StoreFactory', $StoreFactory);

        var def = self._proto, $scope = self._scope;

        def.tasks = nil;
        def.$initialize = function(tasks) {
          var self = this;

          return self.tasks = tasks;
        };

        return (def.$new = function(model) {
          var $a, $b, self = this;

          if ((($a = model['$is_a?']((($b = $scope.ArrayModel) == null ? $opal.cm('ArrayModel') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            return (($a = $scope.ArrayStore) == null ? $opal.cm('ArrayStore') : $a).$new(model, self.tasks)
            } else {
            return (($a = $scope.ModelStore) == null ? $opal.cm('ModelStore') : $a).$new(model, self.tasks)
          };
        }, nil) && 'new';
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$changed']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'Persistors');

      var def = self._proto, $scope = self._scope;

      (function($base, $super) {
        function $Base(){};
        var self = $Base = $klass($base, $super, 'Base', $Base);

        var def = self._proto, $scope = self._scope;

        def.$loaded = function(initial_state) {
          var self = this;

          if (initial_state == null) {
            initial_state = nil
          }
          return nil;
        };

        def.$changed = function(attribute_name) {
          var self = this;

          return nil;
        };

        def.$added = function(model, index) {
          var self = this;

          return nil;
        };

        def.$removed = function(attribute_name) {
          var self = this;

          return self.$changed(attribute_name);
        };

        def.$event_added = function(event, first, first_for_event) {
          var self = this;

          return nil;
        };

        return (def.$event_removed = function(event, last, last_for_event) {
          var self = this;

          return nil;
        }, nil) && 'event_removed';
      })(self, null)
      
    })(self)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$attr_reader', '$==', '$nil?', '$last', '$pop', '$each_with_index', '$-', '$size', '$[]', '$[]=', '$create_new_item', '$to_proc', '$create', '$transform_item', '$alias_method', '$__lookup', '$values', '$<<', '$delete', '$downto']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $GenericPool(){};
      var self = $GenericPool = $klass($base, $super, 'GenericPool', $GenericPool);

      var def = self._proto, $scope = self._scope, TMP_1, TMP_3;

      def.pool = nil;
      self.$attr_reader("pool");

      def.$initialize = function() {
        var self = this;

        return self.pool = $hash2([], {});
      };

      def.$clear = function() {
        var self = this;

        return self.pool = $hash2([], {});
      };

      def.$lookup = TMP_1 = function(args) {try {

        var $a, $b, TMP_2, self = this, $iter = TMP_1._p, block = $iter || nil, section = nil;

        args = $slice.call(arguments, 0);
        TMP_1._p = null;
        section = self.pool;
        if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
          if ((($a = args.$last()['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
            args.$pop()}};
        return ($a = ($b = args).$each_with_index, $a._p = (TMP_2 = function(arg, index){var self = TMP_2._s || this, $a, $b, $c, $d, $e, last = nil, next_section = nil;
if (arg == null) arg = nil;if (index == null) index = nil;
        last = (args.$size()['$-'](1))['$=='](index);
          if (last !== false && last !== nil) {
            $opal.$return((($a = arg, $b = section, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, ($d = ($e = self).$create_new_item, $d._p = block.$to_proc(), $d).apply($e, [].concat(args)))))))
            } else {
            next_section = section['$[]'](arg);
            ((($a = next_section) !== false && $a !== nil) ? $a : next_section = (section['$[]='](arg, $hash2([], {}))));
            return section = next_section;
          };}, TMP_2._s = self, TMP_2), $a).call($b);
        } catch ($returner) { if ($returner === $opal.returner) { return $returner.$v } throw $returner; }
      };

      def.$create_new_item = TMP_3 = function(args) {
        var $a, self = this, $iter = TMP_3._p, $yield = $iter || nil, new_item = nil;

        args = $slice.call(arguments, 0);
        TMP_3._p = null;
        if (($yield !== nil)) {
          new_item = ((($a = $opal.$yieldX($yield, [].concat(args))) === $breaker) ? $breaker.$v : $a)
          } else {
          new_item = ($a = self).$create.apply($a, [].concat(args))
        };
        return self.$transform_item(new_item);
      };

      def.$transform_item = function(item) {
        var self = this;

        return item;
      };

      self.$alias_method("__lookup", "lookup");

      def.$lookup_all = function(args) {
        var $a, $b, TMP_4, self = this, result = nil;

        args = $slice.call(arguments, 0);
        result = ($a = ($b = self).$__lookup, $a._p = (TMP_4 = function(){var self = TMP_4._s || this;

        return nil}, TMP_4._s = self, TMP_4), $a).apply($b, [].concat(args));
        if (result !== false && result !== nil) {
          return result.$values()
          } else {
          return []
        };
      };

      return (def.$remove = function(args) {
        var $a, $b, TMP_5, $c, TMP_6, self = this, stack = nil, section = nil;

        args = $slice.call(arguments, 0);
        stack = [];
        section = self.pool;
        ($a = ($b = args).$each_with_index, $a._p = (TMP_5 = function(arg, index){var self = TMP_5._s || this;
if (arg == null) arg = nil;if (index == null) index = nil;
        stack['$<<'](section);
          if (args.$size()['$-'](1)['$=='](index)) {
            return section.$delete(arg)
            } else {
            return section = section['$[]'](arg)
          };}, TMP_5._s = self, TMP_5), $a).call($b);
        return ($a = ($c = (stack.$size()['$-'](1))).$downto, $a._p = (TMP_6 = function(index){var self = TMP_6._s || this, node = nil, parent = nil;
if (index == null) index = nil;
        node = stack['$[]'](index);
          parent = stack['$[]'](index['$-'](1));
          if (node.$size()['$=='](0)) {
            return parent.$delete(args['$[]'](index['$-'](1)))
            } else {
            return nil
          };}, TMP_6._s = self, TMP_6), $a).call($c, 1);
      }, nil) && 'remove';
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$create', '$__lookup', '$to_proc', '$[]=', '$+', '$[]', '$-', '$==']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $GenericCountingPool(){};
      var self = $GenericCountingPool = $klass($base, $super, 'GenericCountingPool', $GenericCountingPool);

      var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3;

      def.$generate_new = function(args) {
        var $a, self = this;

        args = $slice.call(arguments, 0);
        return [0, ($a = self).$create.apply($a, [].concat(args))];
      };

      def.$find = TMP_1 = function(args) {
        var $a, $b, $c, self = this, $iter = TMP_1._p, block = $iter || nil, item = nil;

        args = $slice.call(arguments, 0);
        TMP_1._p = null;
        item = ($a = ($b = self).$__lookup, $a._p = block.$to_proc(), $a).apply($b, [].concat(args));
        ($a = 0, $c = item, $c['$[]=']($a, $c['$[]']($a)['$+'](1)));
        return item['$[]'](1);
      };

      def.$lookup = TMP_2 = function(args) {
        var self = this, $iter = TMP_2._p, block = $iter || nil, item = nil;

        args = $slice.call(arguments, 0);
        TMP_2._p = null;
        item = $opal.find_super_dispatcher(self, 'lookup', TMP_2, null).apply(self, [].concat(args).concat(block.$to_proc()));
        return item['$[]'](1);
      };

      def.$transform_item = function(item) {
        var self = this;

        return [0, item];
      };

      return (def.$remove = TMP_3 = function(args) {
        var $a, $b, $c, self = this, $iter = TMP_3._p, $yield = $iter || nil, item = nil;

        args = $slice.call(arguments, 0);
        TMP_3._p = null;
        item = ($a = self).$__lookup.apply($a, [].concat(args));
        ($b = 0, $c = item, $c['$[]=']($b, $c['$[]']($b)['$-'](1)));
        if (item['$[]'](0)['$=='](0)) {
          return $opal.find_super_dispatcher(self, 'remove', TMP_3, null).apply(self, [].concat(args))
          } else {
          return nil
        };
      }, nil) && 'remove';
    })(self, (($a = $scope.GenericPool) == null ? $opal.cm('GenericPool') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$[]=']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $ModelIdentityMap(){};
      var self = $ModelIdentityMap = $klass($base, $super, 'ModelIdentityMap', $ModelIdentityMap);

      var def = self._proto, $scope = self._scope;

      def.pool = nil;
      return (def.$add = function(id, model) {
        var self = this;

        return self.pool['$[]='](id, [1, model]);
      }, nil) && 'add'
    })(self, (($a = $scope.GenericCountingPool) == null ? $opal.cm('GenericCountingPool') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$new', '$merge', '$options', '$+', '$path', '$plural?', '$new_array_model', '$new_model', '$attributes', '$attributes=', '$[]=']);
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'Persistors');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $Store(){};
        var self = $Store = $klass($base, $super, 'Store', $Store);

        var def = self._proto, $scope = self._scope, $a;

        def.saved = def.model = nil;
        ($opal.cvars['@@identity_map'] = (($a = $scope.ModelIdentityMap) == null ? $opal.cm('ModelIdentityMap') : $a).$new());

        def.$initialize = function(model, tasks) {
          var self = this;

          if (tasks == null) {
            tasks = nil
          }
          self.tasks = tasks;
          self.model = model;
          return self.saved = false;
        };

        def['$saved?'] = function() {
          var self = this;

          return self.saved;
        };

        return (def.$read_new_model = function(method_name) {
          var $a, $b, self = this, options = nil, model = nil;

          options = self.model.$options().$merge($hash2(["parent", "path"], {"parent": self.model, "path": self.model.$path()['$+']([method_name])}));
          if ((($a = method_name['$plural?']()) !== nil && (!$a._isBoolean || $a == true))) {
            model = self.model.$new_array_model([], options)
            } else {
            model = self.model.$new_model(nil, options);
            ($a = self.model, ((($b = $a.$attributes()) !== false && $b !== nil) ? $b : $a['$attributes=']($hash2([], {}))));
            self.model.$attributes()['$[]='](method_name, model);
          };
          return model;
        }, nil) && 'read_new_model';
      })(self, (($a = $scope.Base) == null ? $opal.cm('Base') : $a))
      
    })(self)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$fail', '$puts', '$inspect', '$then', '$each', '$>', '$size', '$model', '$clear', '$add', '$change_state_to', '$dup', '$add_listener', '$<<', '$each_with_index', '$to_h', '$first', '$delete', '$==', '$remove', '$remove_listener', '$changed']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $QueryListener(){};
      var self = $QueryListener = $klass($base, $super, 'QueryListener', $QueryListener);

      var def = self._proto, $scope = self._scope, TMP_5;

      def.collection = def.query = def.stores = def.listening = def.query_listener_pool = nil;
      def.$initialize = function(query_listener_pool, tasks, collection, query) {
        var self = this;

        self.query_listener_pool = query_listener_pool;
        self.tasks = tasks;
        self.stores = [];
        self.collection = collection;
        self.query = query;
        return self.listening = false;
      };

      def.$add_listener = function() {
        var $a, $b, TMP_1, $c, $d, TMP_2, $e, self = this;

        self.listening = true;
        return ($a = ($b = ($c = ($d = (($e = $scope.QueryTasks) == null ? $opal.cm('QueryTasks') : $e).$add_listener(self.collection, self.query)).$then, $c._p = (TMP_2 = function(ret){var self = TMP_2._s || this, $a, $b, TMP_3, results = nil, errors = nil;
          if (self.stores == null) self.stores = nil;
if (ret == null) ret = nil;
        $a = $opal.to_ary(ret), results = ($a[0] == null ? nil : $a[0]), errors = ($a[1] == null ? nil : $a[1]);
          return ($a = ($b = self.stores.$dup()).$each, $a._p = (TMP_3 = function(store){var self = TMP_3._s || this, $a, $b, TMP_4;
if (store == null) store = nil;
          if (store.$model().$size()['$>'](0)) {
              store.$model().$clear()};
            ($a = ($b = results).$each, $a._p = (TMP_4 = function(index, data){var self = TMP_4._s || this;
if (index == null) index = nil;if (data == null) data = nil;
            return store.$add(index, data)}, TMP_4._s = self, TMP_4), $a).call($b);
            return store.$change_state_to("loaded");}, TMP_3._s = self, TMP_3), $a).call($b);}, TMP_2._s = self, TMP_2), $c).call($d)).$fail, $a._p = (TMP_1 = function(err){var self = TMP_1._s || this;
if (err == null) err = nil;
        return self.$puts("Error adding listener: " + (err.$inspect()))}, TMP_1._s = self, TMP_1), $a).call($b);
      };

      def.$add_store = TMP_5 = function(store) {
        var $a, $b, TMP_6, self = this, $iter = TMP_5._p, block = $iter || nil;

        TMP_5._p = null;
        self.stores['$<<'](store);
        if ((($a = self.listening) !== nil && (!$a._isBoolean || $a == true))) {
          store.$model().$clear();
          ($a = ($b = self.stores.$first().$model()).$each_with_index, $a._p = (TMP_6 = function(item, index){var self = TMP_6._s || this;
if (item == null) item = nil;if (index == null) index = nil;
          return store.$add(index, item.$to_h())}, TMP_6._s = self, TMP_6), $a).call($b);
          return store.$change_state_to("loaded");
          } else {
          return self.$add_listener()
        };
      };

      def.$remove_store = function(store) {
        var $a, self = this;

        self.stores.$delete(store);
        if (self.stores.$size()['$=='](0)) {
          self.query_listener_pool.$remove(self.collection, self.query);
          if ((($a = self.listening) !== nil && (!$a._isBoolean || $a == true))) {
            self.listening = false;
            return (($a = $scope.QueryTasks) == null ? $opal.cm('QueryTasks') : $a).$remove_listener(self.collection, self.query);
            } else {
            return nil
          };
          } else {
          return nil
        };
      };

      def.$added = function(index, data) {
        var $a, $b, TMP_7, self = this;

        return ($a = ($b = self.stores).$each, $a._p = (TMP_7 = function(store){var self = TMP_7._s || this;
if (store == null) store = nil;
        return store.$add(index, data)}, TMP_7._s = self, TMP_7), $a).call($b);
      };

      def.$removed = function(ids) {
        var $a, $b, TMP_8, self = this;

        return ($a = ($b = self.stores).$each, $a._p = (TMP_8 = function(store){var self = TMP_8._s || this;
if (store == null) store = nil;
        return store.$remove(ids)}, TMP_8._s = self, TMP_8), $a).call($b);
      };

      return (def.$changed = function(model_id, data) {
        var $a, $b, self = this;

        $gvars.loading_models = true;
        self.$puts("new data: " + (data.$inspect()));
        (($a = ((($b = $scope.Persistors) == null ? $opal.cm('Persistors') : $b))._scope).ModelStore == null ? $a.cm('ModelStore') : $a.ModelStore).$changed(model_id, data);
        return $gvars.loading_models = false;
      }, nil) && 'changed';
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$puts', '$each_pair', '$each_key', '$inspect']);
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $QueryListenerPool(){};
      var self = $QueryListenerPool = $klass($base, $super, 'QueryListenerPool', $QueryListenerPool);

      var def = self._proto, $scope = self._scope;

      def.pool = nil;
      return (def.$print = function() {
        var $a, $b, TMP_1, self = this;

        self.$puts("--- Running Queries ---");
        return ($a = ($b = self.pool).$each_pair, $a._p = (TMP_1 = function(table, query_hash){var self = TMP_1._s || this, $a, $b, TMP_2;
if (table == null) table = nil;if (query_hash == null) query_hash = nil;
        return ($a = ($b = query_hash).$each_key, $a._p = (TMP_2 = function(query){var self = TMP_2._s || this;
if (query == null) query = nil;
          return self.$puts("" + (table) + ": " + (query.$inspect()))}, TMP_2._s = self, TMP_2), $a).call($b)}, TMP_1._s = self, TMP_1), $a).call($b);
      }, nil) && 'print'
    })(self, (($a = $scope.GenericPool) == null ? $opal.cm('GenericPool') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module;

  $opal.add_stubs(['$change_state_to', '$new', '$depend', '$!', '$==', '$changed!', '$each', '$resolve', '$compact', '$stop_listening']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'Persistors');

      var def = self._proto, $scope = self._scope;

      (function($base) {
        var self = $module($base, 'StoreState');

        var def = self._proto, $scope = self._scope;

        def.$loaded = function(initial_state) {
          var $a, self = this;

          if (initial_state == null) {
            initial_state = nil
          }
          return self.$change_state_to(((($a = initial_state) !== false && $a !== nil) ? $a : "not_loaded"));
        };

        def.$state = function() {
          var $a, $b, self = this;
          if (self.state_dep == null) self.state_dep = nil;
          if (self.state == null) self.state = nil;

          ((($a = self.state_dep) !== false && $a !== nil) ? $a : self.state_dep = (($b = $scope.Dependency) == null ? $opal.cm('Dependency') : $b).$new());
          self.state_dep.$depend();
          return self.state;
        };

        def.$change_state_to = function(new_state) {
          var $a, $b, TMP_1, self = this, old_state = nil;
          if (self.state == null) self.state = nil;
          if (self.state_dep == null) self.state_dep = nil;
          if (self.fetch_promises == null) self.fetch_promises = nil;

          old_state = self.state;
          self.state = new_state;
          if ((($a = old_state['$=='](self.state)['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = self.state_dep) !== nil && (!$a._isBoolean || $a == true))) {
              self.state_dep['$changed!']()}};
          if ((($a = (($b = self.state['$==']("loaded")) ? self.fetch_promises : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            ($a = ($b = self.fetch_promises.$compact()).$each, $a._p = (TMP_1 = function(fp){var self = TMP_1._s || this;
              if (self.model == null) self.model = nil;
if (fp == null) fp = nil;
            return fp.$resolve(self.model)}, TMP_1._s = self, TMP_1), $a).call($b);
            self.fetch_promises = nil;
            return self.$stop_listening();
            } else {
            return nil
          };
        };
                ;$opal.donate(self, ["$loaded", "$state", "$change_state_to"]);
      })(self)
      
    })(self)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2, $gvars = $opal.gvars;

  $opal.add_stubs(['$include', '$new', '$attr_reader', '$[]', '$options', '$==', '$load_data', '$stop_listening', '$>', '$size', '$stop', '$remove_store', '$change_state_to', '$is_a?', '$watch!', '$lambda', '$call', '$run_query', '$puts', '$clear', '$last', '$path', '$parent', '$persistor', '$ensure_setup', '$attributes', '$true?', '$[]=', '$to_s', '$singularize', '$lookup', '$add_store', '$fail', '$merge', '$raise', '$then', '$to_proc', '$resolve', '$<<', '$find', '$_id', '$array', '$+', '$new_model', '$insert', '$each', '$each_with_index', '$delete_at', '$add_to_collection', '$remove_from_collection', '$delete', '$channel_name']);
  ;
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'Persistors');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $ArrayStore(){};
        var self = $ArrayStore = $klass($base, $super, 'ArrayStore', $ArrayStore);

        var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_4, TMP_5;

        def.model = def.skip = def.has_events = def.fetch_promises = def.query_computation = def.query_listener = def.state = def.query = def.limit = nil;
        self.$include((($a = $scope.StoreState) == null ? $opal.cm('StoreState') : $a));

        ($opal.cvars['@@query_pool'] = (($a = $scope.QueryListenerPool) == null ? $opal.cm('QueryListenerPool') : $a).$new());

        self.$attr_reader("model");

        $opal.defs(self, '$query_pool', function() {
          var $a, self = this;

          return (($a = $opal.cvars['@@query_pool']) == null ? nil : $a);
        });

        def.$initialize = TMP_1 = function(model, tasks) {var $zuper = $slice.call(arguments, 0);
          var self = this, $iter = TMP_1._p, $yield = $iter || nil;

          if (tasks == null) {
            tasks = nil
          }
          TMP_1._p = null;
          $opal.find_super_dispatcher(self, 'initialize', TMP_1, $iter).apply(self, $zuper);
          self.query = self.model.$options()['$[]']("query");
          self.limit = self.model.$options()['$[]']("limit");
          self.skip = self.model.$options()['$[]']("skip");
          if (self.skip['$=='](0)) {
            return self.skip = nil
            } else {
            return nil
          };
        };

        def.$event_added = function(event, first, first_for_event) {
          var self = this;

          if (first !== false && first !== nil) {
            self.has_events = true;
            return self.$load_data();
            } else {
            return nil
          };
        };

        def.$event_removed = function(event, last, last_for_event) {
          var self = this;

          if (last !== false && last !== nil) {
            self.has_events = false;
            return self.$stop_listening();
            } else {
            return nil
          };
        };

        def.$stop_listening = function(stop_watching_query) {
          var $a, $b, self = this;

          if (stop_watching_query == null) {
            stop_watching_query = true
          }
          if ((($a = self.has_events) !== nil && (!$a._isBoolean || $a == true))) {
            return nil};
          if ((($a = ($b = self.fetch_promises, $b !== false && $b !== nil ?self.fetch_promises.$size()['$>'](0) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            return nil};
          if ((($a = ($b = self.query_computation, $b !== false && $b !== nil ?stop_watching_query : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            self.query_computation.$stop()};
          if ((($a = self.query_listener) !== nil && (!$a._isBoolean || $a == true))) {
            self.query_listener.$remove_store(self);
            self.query_listener = nil;};
          return self.state = "dirty";
        };

        def.$load_data = function() {
          var $a, $b, TMP_2, self = this;

          if ((($a = ((($b = self.state['$==']("not_loaded")) !== false && $b !== nil) ? $b : self.state['$==']("dirty"))) !== nil && (!$a._isBoolean || $a == true))) {
            self.$change_state_to("loading");
            if ((($a = self.query['$is_a?']((($b = $scope.Proc) == null ? $opal.cm('Proc') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
              return self.query_computation = ($a = ($b = self).$lambda, $a._p = (TMP_2 = function(){var self = TMP_2._s || this, new_query = nil;
                if (self.query == null) self.query = nil;
                if (self.model == null) self.model = nil;
                if (self.skip == null) self.skip = nil;
                if (self.limit == null) self.limit = nil;

              self.$stop_listening(false);
                self.$change_state_to("loading");
                new_query = self.query.$call();
                return self.$run_query(self.model, self.query.$call(), self.skip, self.limit);}, TMP_2._s = self, TMP_2), $a).call($b)['$watch!']()
              } else {
              return self.$run_query(self.model, self.query, self.skip, self.limit)
            };
            } else {
            return nil
          };
        };

        def.$unload_data = function() {
          var self = this;

          self.$puts("Unload Data");
          self.$change_state_to("not_loaded");
          return self.model.$clear();
        };

        def.$run_query = function(model, query, skip, limit) {
          var $a, $b, $c, TMP_3, self = this, collection = nil, parent = nil, attrs = nil, full_query = nil;

          if (query == null) {
            query = $hash2([], {})
          }
          if (skip == null) {
            skip = nil
          }
          if (limit == null) {
            limit = nil
          }
          self.model.$clear();
          collection = model.$path().$last();
          if (model.$path().$size()['$>'](1)) {
            parent = model.$parent();
            if ((($a = parent.$persistor()) !== nil && (!$a._isBoolean || $a == true))) {
              parent.$persistor().$ensure_setup()};
            if ((($a = ($b = (($c = parent !== false && parent !== nil) ? (attrs = parent.$attributes()) : $c), $b !== false && $b !== nil ?attrs['$[]']("_id")['$true?']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
              query['$[]='](("" + model.$path()['$[]'](-3).$singularize().$to_s() + "_id"), attrs['$[]']("_id"))};};
          full_query = [query, skip, limit];
          self.query_listener = ($a = ($b = (($c = $opal.cvars['@@query_pool']) == null ? nil : $c)).$lookup, $a._p = (TMP_3 = function(){var self = TMP_3._s || this, $a;
            if (self.tasks == null) self.tasks = nil;

          return (($a = $scope.QueryListener) == null ? $opal.cm('QueryListener') : $a).$new((($a = $opal.cvars['@@query_pool']) == null ? nil : $a), self.tasks, collection, full_query)}, TMP_3._s = self, TMP_3), $a).call($b, collection, full_query);
          return self.query_listener.$add_store(self);
        };

        def.$find = TMP_4 = function(query) {
          var $a, self = this, $iter = TMP_4._p, block = $iter || nil;

          if (query == null) {
            query = nil
          }
          TMP_4._p = null;
          if (block !== false && block !== nil) {
            if (query !== false && query !== nil) {
              self.$fail("Query should not be passed in to a find if a block is specified")};
            query = block;
            } else {
            ((($a = query) !== false && $a !== nil) ? $a : query = $hash2([], {}))
          };
          return (($a = $scope.Cursor) == null ? $opal.cm('Cursor') : $a).$new([], self.model.$options().$merge($hash2(["query"], {"query": query})));
        };

        def.$limit = function(limit) {
          var $a, self = this;

          return (($a = $scope.Cursor) == null ? $opal.cm('Cursor') : $a).$new([], self.model.$options().$merge($hash2(["limit"], {"limit": limit})));
        };

        def.$skip = function(skip) {
          var $a, self = this;

          return (($a = $scope.Cursor) == null ? $opal.cm('Cursor') : $a).$new([], self.model.$options().$merge($hash2(["skip"], {"skip": skip})));
        };

        def.$then = TMP_5 = function() {
          var $a, $b, self = this, $iter = TMP_5._p, block = $iter || nil, promise = nil;

          TMP_5._p = null;
          if (block !== false && block !== nil) {
            } else {
            self.$raise("then must pass a block")
          };
          promise = (($a = $scope.Promise) == null ? $opal.cm('Promise') : $a).$new();
          promise = ($a = ($b = promise).$then, $a._p = block.$to_proc(), $a).call($b);
          if (self.state['$==']("loaded")) {
            promise.$resolve(self.model)
            } else {
            ((($a = self.fetch_promises) !== false && $a !== nil) ? $a : self.fetch_promises = []);
            self.fetch_promises['$<<'](promise);
            self.$load_data();
          };
          return promise;
        };

        def.$add = function(index, data) {
          var $a, $b, $c, TMP_6, TMP_7, $d, self = this, data_id = nil, new_model = nil;

          $gvars.loading_models = true;
          data_id = ((($a = data['$[]']("_id")) !== false && $a !== nil) ? $a : data['$[]']("_id"));
          if ((($a = ($b = ($c = self.model.$array()).$find, $b._p = (TMP_6 = function(v){var self = TMP_6._s || this;
if (v == null) v = nil;
          return v.$_id()['$=='](data_id)}, TMP_6._s = self, TMP_6), $b).call($c)) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            new_model = ($a = ($b = (($d = $opal.cvars['@@identity_map']) == null ? nil : $d)).$find, $a._p = (TMP_7 = function(){var self = TMP_7._s || this, new_options = nil;
              if (self.model == null) self.model = nil;

            new_options = self.model.$options().$merge($hash2(["path", "parent"], {"path": self.model.$path()['$+'](["[]"]), "parent": self.model}));
              return self.model.$new_model(data, new_options, "loaded");}, TMP_7._s = self, TMP_7), $a).call($b, data_id);
            self.model.$insert(index, new_model);
          };
          return $gvars.loading_models = false;
        };

        def.$remove = function(ids) {
          var $a, $b, TMP_8, self = this;

          $gvars.loading_models = true;
          ($a = ($b = ids).$each, $a._p = (TMP_8 = function(id){var self = TMP_8._s || this, $a, $b, TMP_9;
            if (self.model == null) self.model = nil;
if (id == null) id = nil;
          return ($a = ($b = self.model).$each_with_index, $a._p = (TMP_9 = function(model, index){var self = TMP_9._s || this, del = nil;
              if (self.model == null) self.model = nil;
if (model == null) model = nil;if (index == null) index = nil;
            if (model.$_id()['$=='](id)) {
                del = self.model.$delete_at(index);
                return ($breaker.$v = nil, $breaker);
                } else {
                return nil
              }}, TMP_9._s = self, TMP_9), $a).call($b)}, TMP_8._s = self, TMP_8), $a).call($b);
          return $gvars.loading_models = false;
        };

        def.$channel_name = function() {
          var self = this;

          return self.model.$path()['$[]'](-1);
        };

        def.$added = function(model, index) {
          var $a, self = this;

          if ((($a = model.$persistor()) !== nil && (!$a._isBoolean || $a == true))) {
            return model.$persistor().$add_to_collection()
            } else {
            return nil
          };
        };

        return (def.$removed = function(model) {
          var $a, $b, self = this;
          if ($gvars.loading_models == null) $gvars.loading_models = nil;

          if ((($a = model.$persistor()) !== nil && (!$a._isBoolean || $a == true))) {
            model.$persistor().$remove_from_collection()};
          if ((($a = ($b = ($gvars["loading_models"] != null ? 'global-variable' : nil), $b !== false && $b !== nil ?$gvars.loading_models : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            return nil
            } else {
            return (($a = $scope.StoreTasks) == null ? $opal.cm('StoreTasks') : $a).$delete(self.$channel_name(), model.$attributes()['$[]']("_id"))
          };
        }, nil) && 'removed';
      })(self, (($a = $scope.Store) == null ? $opal.cm('Store') : $a))
      
    })(self)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $range = $opal.range, $gvars = $opal.gvars, $hash2 = $opal.hash2;

  $opal.add_stubs(['$==', '$include', '$flatten', '$map', '$to_proc', '$attr_reader', '$attr_accessor', '$ensure_setup', '$changed', '$attributes', '$[]', '$[]=', '$generate_id', '$add_to_identity_map', '$add', '$_id', '$times', '$<<', '$sample', '$join', '$!', '$path', '$new', '$size', '$save_changes?', '$>', '$nil?', '$parent', '$to_s', '$singularize', '$collection', '$puts', '$fail', '$queue_client_save', '$each', '$reject', '$then', '$resolve', '$save', '$self_attributes', '$nosave', '$lookup', '$each_pair', '$send', '$private', '$is_a?', '$fetch', '$errors', '$present?', '$insert', '$db', '$message', '$dup', '$delete', '$update', '$updated_collection', '$live_query_pool', '$current']);
  ;
  ;
  if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {};
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'Persistors');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $ModelStore(){};
        var self = $ModelStore = $klass($base, $super, 'ModelStore', $ModelStore);

        var def = self._proto, $scope = self._scope, $a, $b, TMP_1, $c;

        def.model = def.in_identity_map = def.tasks = def.save_promises = nil;
        self.$include((($a = $scope.StoreState) == null ? $opal.cm('StoreState') : $a));

        $opal.cdecl($scope, 'ID_CHARS', ($a = ($b = [($range("a", "f", false)), ($range("0", "9", false))]).$map, $a._p = "to_a".$to_proc(), $a).call($b).$flatten());

        self.$attr_reader("model");

        self.$attr_accessor("in_identity_map");

        def.$initialize = TMP_1 = function(model, tasks) {var $zuper = $slice.call(arguments, 0);
          var self = this, $iter = TMP_1._p, $yield = $iter || nil;

          TMP_1._p = null;
          $opal.find_super_dispatcher(self, 'initialize', TMP_1, $iter).apply(self, $zuper);
          return self.in_identity_map = false;
        };

        def.$add_to_collection = function() {
          var self = this;

          self.in_collection = true;
          self.$ensure_setup();
          return self.$changed();
        };

        def.$remove_from_collection = function() {
          var self = this;

          return self.in_collection = false;
        };

        def.$ensure_setup = function() {
          var $a, $b, $c, self = this;

          if ((($a = self.model.$attributes()) !== nil && (!$a._isBoolean || $a == true))) {
            ($a = "_id", $b = self.model.$attributes(), ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, self.$generate_id())));
            return self.$add_to_identity_map();
            } else {
            return nil
          };
        };

        def.$add_to_identity_map = function() {
          var $a, self = this;

          if ((($a = self.in_identity_map) !== nil && (!$a._isBoolean || $a == true))) {
            return nil
            } else {
            (($a = $opal.cvars['@@identity_map']) == null ? nil : $a).$add(self.model.$_id(), self.model);
            return self.in_identity_map = true;
          };
        };

        def.$generate_id = function() {
          var $a, $b, TMP_2, self = this, id = nil;

          id = [];
          ($a = ($b = (24)).$times, $a._p = (TMP_2 = function(){var self = TMP_2._s || this, $a;

          return id['$<<']((($a = $scope.ID_CHARS) == null ? $opal.cm('ID_CHARS') : $a).$sample())}, TMP_2._s = self, TMP_2), $a).call($b);
          return id.$join();
        };

        def['$save_changes?'] = function() {
          var $a, $b, self = this;
          if ($gvars.loading_models == null) $gvars.loading_models = nil;

          if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
            return ($a = (($b = ($gvars["loading_models"] != null ? 'global-variable' : nil), $b !== false && $b !== nil ?$gvars.loading_models : $b))['$!'](), $a !== false && $a !== nil ?self.tasks : $a)};
        };

        def.$changed = function(attribute_name) {
          var $a, $b, $c, self = this, path = nil, promise = nil, path_size = nil, parent = nil, source = nil;

          if (attribute_name == null) {
            attribute_name = nil
          }
          path = self.model.$path();
          promise = (($a = $scope.Promise) == null ? $opal.cm('Promise') : $a).$new();
          self.$ensure_setup();
          path_size = path.$size();
          if ((($a = ($b = ($c = self['$save_changes?'](), $c !== false && $c !== nil ?path_size['$>'](0) : $c), $b !== false && $b !== nil ?self.model['$nil?']()['$!']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = ($b = (($c = path_size['$>'](3)) ? (parent = self.model.$parent()) : $c), $b !== false && $b !== nil ?(source = parent.$parent()) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
              self.model.$attributes()['$[]='](("" + path['$[]'](-4).$singularize().$to_s() + "_id"), source.$_id())};
            if ((($a = self.$collection()['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
              self.$puts("Attempting to save model directly on store.");
              self.$fail("Attempting to save model directly on store.");
            } else if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
              ((($a = self.save_promises) !== false && $a !== nil) ? $a : self.save_promises = []);
              self.save_promises['$<<'](promise);
              self.$queue_client_save();};};
          return promise;
        };

        def.$queue_client_save = function() {
          var self = this;

          
        if (!self.saveTimer) {
          self.saveTimer = setImmediate(self.$run_save.bind(self));
        }
        
        };

        def.$run_save = function() {
          var $a, $b, TMP_3, $c, $d, TMP_5, $e, self = this;

          
        clearImmediate(self.saveTimer);
        delete self.saveTimer;
        
          return ($a = ($b = ($c = ($d = (($e = $scope.StoreTasks) == null ? $opal.cm('StoreTasks') : $e).$save(self.$collection(), self.model.$path(), self.$self_attributes())).$then, $c._p = (TMP_5 = function(){var self = TMP_5._s || this, $a, $b, TMP_6, save_promises = nil;
            if (self.save_promises == null) self.save_promises = nil;

          save_promises = self.save_promises;
            self.save_promises = nil;
            return ($a = ($b = save_promises).$each, $a._p = (TMP_6 = function(promise){var self = TMP_6._s || this;
if (promise == null) promise = nil;
            return promise.$resolve(nil)}, TMP_6._s = self, TMP_6), $a).call($b);}, TMP_5._s = self, TMP_5), $c).call($d)).$fail, $a._p = (TMP_3 = function(errors){var self = TMP_3._s || this, $a, $b, TMP_4, save_promises = nil;
            if (self.save_promises == null) self.save_promises = nil;
if (errors == null) errors = nil;
          save_promises = self.save_promises;
            self.save_promises = nil;
            return ($a = ($b = save_promises).$each, $a._p = (TMP_4 = function(promise){var self = TMP_4._s || this;
if (promise == null) promise = nil;
            return promise.$reject(errors)}, TMP_4._s = self, TMP_4), $a).call($b);}, TMP_3._s = self, TMP_3), $a).call($b);
        };

        def.$event_added = function(event, first, first_for_event) {
          var $a, $b, self = this;

          if ((($a = (($b = first_for_event !== false && first_for_event !== nil) ? event['$==']("changed") : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            return self.$ensure_setup()
            } else {
            return nil
          };
        };

        $opal.defs(self, '$changed', function(model_id, data) {
          var $a, $b, TMP_7, $c, self = this;

          return ($a = ($b = (($c = $scope.Model) == null ? $opal.cm('Model') : $c)).$nosave, $a._p = (TMP_7 = function(){var self = TMP_7._s || this, $a, $b, TMP_8, model = nil;

          model = (($a = $opal.cvars['@@identity_map']) == null ? nil : $a).$lookup(model_id);
            if (model !== false && model !== nil) {
              return ($a = ($b = data).$each_pair, $a._p = (TMP_8 = function(key, value){var self = TMP_8._s || this, $a;
if (key == null) key = nil;if (value == null) value = nil;
              if ((($a = key['$==']("_id")['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
                  return model.$send(("_" + key.$to_s() + "="), value)
                  } else {
                  return nil
                }}, TMP_8._s = self, TMP_8), $a).call($b)
              } else {
              return nil
            };}, TMP_7._s = self, TMP_7), $a).call($b);
        });

        def['$[]'] = function(val) {
          var self = this;

          return self.$fail("Models do not support hash style lookup.  Hashes inserted into other models are converted to models, see https://github.com/voltrb/volt#automatic-model-conversion");
        };

        self.$private();

        def.$self_attributes = function() {
          var $a, $b, TMP_9, self = this;

          return ($a = ($b = self.model.$attributes()).$reject, $a._p = (TMP_9 = function(k, v){var self = TMP_9._s || this, $a, $b;
if (k == null) k = nil;if (v == null) v = nil;
          return ((($a = v['$is_a?']((($b = $scope.Model) == null ? $opal.cm('Model') : $b))) !== false && $a !== nil) ? $a : v['$is_a?']((($b = $scope.ArrayModel) == null ? $opal.cm('ArrayModel') : $b)))}, TMP_9._s = self, TMP_9), $a).call($b);
        };

        def.$collection = function() {
          var self = this;

          return self.model.$path()['$[]'](-2);
        };

        if ((($a = (($c = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $c)['$==']("opal")['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
          def.$db = function() {
            var $a, $b, $c, self = this;

            return ((($a = (($b = $opal.cvars['@@db']) == null ? nil : $b)) !== false && $a !== nil) ? $a : ($opal.cvars['@@db'] = (($b = ((($c = $scope.Volt) == null ? $opal.cm('Volt') : $c))._scope).DataStore == null ? $b.cm('DataStore') : $b.DataStore).$fetch()));
          };

          return (def['$save_to_db!'] = function(values) {
            var $a, $b, self = this, errors = nil, id = nil, error = nil, update_values = nil;

            errors = self.model.$errors();
            if ((($a = errors['$present?']()) !== nil && (!$a._isBoolean || $a == true))) {
              return errors};
            id = values['$[]']("_id");
            try {
            self.$db()['$[]'](self.$collection()).$insert(values)
            } catch ($err) {if ($opal.$rescue($err, [(($a = ((($b = $scope.Mongo) == null ? $opal.cm('Mongo') : $b))._scope).OperationFailure == null ? $a.cm('OperationFailure') : $a.OperationFailure)])) {error = $err;
              if ((($a = error.$message()['$[]'](/^11000[:]/)) !== nil && (!$a._isBoolean || $a == true))) {
                update_values = values.$dup();
                update_values.$delete("_id");
                self.$db()['$[]'](self.$collection()).$update($hash2(["_id"], {"_id": id}), update_values);
                } else {
                return $hash2(["error"], {"error": error.$message()})
              }
              }else { throw $err; }
            };
            (($a = $scope.QueryTasks) == null ? $opal.cm('QueryTasks') : $a).$live_query_pool().$updated_collection(self.$collection().$to_s(), (($a = $scope.Thread) == null ? $opal.cm('Thread') : $a).$current()['$[]']("in_channel"));
            return $hash2([], {});
          }, nil) && 'save_to_db!';
          } else {
          return nil
        };
      })(self, (($a = $scope.Store) == null ? $opal.cm('Store') : $a))
      
    })(self)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$==', '$client?', '$update!', '$url']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'Persistors');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $Params(){};
        var self = $Params = $klass($base, $super, 'Params', $Params);

        var def = self._proto, $scope = self._scope;

        def.$initialize = function(model) {
          var self = this;

          return self.model = model;
        };

        def.$changed = function(attribute_name) {
          var $a, self = this;

          if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
            
            if (window.setTimeout && this.$run_update.bind) {
              if (window.paramsUpdateTimer) {
                clearTimeout(window.paramsUpdateTimer);
              }
              window.paramsUpdateTimer = setTimeout(this.$run_update.bind(this), 0);
            }
          };
        };

        return (def.$run_update = function() {
          var $a, $b, self = this;
          if ($gvars.page == null) $gvars.page = nil;

          if ((($a = (($b = $scope.Volt) == null ? $opal.cm('Volt') : $b)['$client?']()) !== nil && (!$a._isBoolean || $a == true))) {
            return $gvars.page.$url()['$update!']()
            } else {
            return nil
          };
        }, nil) && 'run_update';
      })(self, (($a = $scope.Base) == null ? $opal.cm('Base') : $a))
      
    })(self)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2, $gvars = $opal.gvars;

  $opal.add_stubs(['$[]', '$map', '$strip', '$split', '$==', '$size', '$<<', '$join', '$!', '$path', '$writing_cookies', '$each_pair', '$assign_attribute', '$read_cookies', '$read_attribute', '$write_cookie', '$to_s', '$+', '$now', '$*']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'Persistors');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $Cookies(){};
        var self = $Cookies = $klass($base, $super, 'Cookies', $Cookies);

        var def = self._proto, $scope = self._scope, TMP_6;

        def.loaded = def.model = nil;
        def.$read_cookies = function() {
          var $a, $b, TMP_1, self = this, cookies = nil;

          cookies = document.cookie;
          return (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a)['$[]'](($a = ($b = cookies.$split(";")).$map, $a._p = (TMP_1 = function(v){var self = TMP_1._s || this, $a, $b, TMP_2, parts = nil;
if (v == null) v = nil;
          parts = ($a = ($b = v.$split("=")).$map, $a._p = (TMP_2 = function(p){var self = TMP_2._s || this;
if (p == null) p = nil;
            p = p.$strip();
              return decodeURIComponent(p);}, TMP_2._s = self, TMP_2), $a).call($b);
            if (parts.$size()['$=='](1)) {
              parts['$<<']("")};
            return parts;}, TMP_1._s = self, TMP_1), $a).call($b));
        };

        def.$write_cookie = function(key, value, options) {
          var $a, self = this, parts = nil, expires = nil, cookie_val = nil;

          if (options == null) {
            options = $hash2([], {})
          }
          parts = [];
          parts['$<<'](encodeURIComponent(key));
          parts['$<<']("=");
          parts['$<<'](encodeURIComponent(value));
          parts['$<<']("; ");
          if ((($a = options['$[]']("max_age")) !== nil && (!$a._isBoolean || $a == true))) {
            parts['$<<']("max-age=")['$<<'](options['$[]']("max_age"))['$<<']("; ")};
          if ((($a = options['$[]']("expires")) !== nil && (!$a._isBoolean || $a == true))) {
            expires = options['$[]']("expires");
            parts['$<<']("expires=")['$<<'](expires.toGMTString())['$<<']("; ");};
          if ((($a = options['$[]']("path")) !== nil && (!$a._isBoolean || $a == true))) {
            parts['$<<']("path=")['$<<'](options['$[]']("path"))['$<<']("; ")};
          if ((($a = options['$[]']("domain")) !== nil && (!$a._isBoolean || $a == true))) {
            parts['$<<']("domain=")['$<<'](options['$[]']("domain"))['$<<']("; ")};
          if ((($a = options['$[]']("secure")) !== nil && (!$a._isBoolean || $a == true))) {
            parts['$<<']("secure")};
          cookie_val = parts.$join();
          return document.cookie = cookie_val;
        };

        def.$initialize = function(model) {
          var self = this;

          return self.model = model;
        };

        def.$added = function(model, index) {
          var self = this;

          return nil;
        };

        def.$loaded = function(initial_state) {
          var $a, $b, TMP_3, self = this;

          if (initial_state == null) {
            initial_state = nil
          }
          if ((($a = ($b = self.loaded['$!'](), $b !== false && $b !== nil ?self.model.$path()['$==']([]) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            self.loaded = true;
            return ($a = ($b = self).$writing_cookies, $a._p = (TMP_3 = function(){var self = TMP_3._s || this, $a, $b, TMP_4;

            return ($a = ($b = self.$read_cookies()).$each_pair, $a._p = (TMP_4 = function(key, value){var self = TMP_4._s || this;
                if (self.model == null) self.model = nil;
if (key == null) key = nil;if (value == null) value = nil;
              return self.model.$assign_attribute(key, value)}, TMP_4._s = self, TMP_4), $a).call($b)}, TMP_3._s = self, TMP_3), $a).call($b);
            } else {
            return nil
          };
        };

        def.$changed = function(attribute_name) {
          var $a, self = this, value = nil;
          if ($gvars.writing_cookies == null) $gvars.writing_cookies = nil;

          if ((($a = $gvars.writing_cookies) !== nil && (!$a._isBoolean || $a == true))) {
            return nil
            } else {
            value = self.model.$read_attribute(attribute_name);
            return self.$write_cookie(attribute_name, value.$to_s(), $hash2(["expires"], {"expires": (($a = $scope.Time) == null ? $opal.cm('Time') : $a).$now()['$+'](((356)['$*'](24)['$*'](60)['$*'](60)))}));
          };
        };

        def.$removed = function(attribute_name) {
          var $a, $b, TMP_5, self = this;

          return ($a = ($b = self).$writing_cookies, $a._p = (TMP_5 = function(){var self = TMP_5._s || this, $a;

          return self.$write_cookie(attribute_name, "", $hash2(["expires"], {"expires": (($a = $scope.Time) == null ? $opal.cm('Time') : $a).$now()}))}, TMP_5._s = self, TMP_5), $a).call($b);
        };

        return (def.$writing_cookies = TMP_6 = function() {
          var self = this, $iter = TMP_6._p, $yield = $iter || nil;

          TMP_6._p = null;
          $gvars.writing_cookies = true;
          if ($opal.$yieldX($yield, []) === $breaker) return $breaker.$v;
          return $gvars.writing_cookies = false;
        }, nil) && 'writing_cookies';
      })(self, (($a = $scope.Base) == null ? $opal.cm('Base') : $a))
      
    })(self)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$client?', '$delete', '$==', '$size', '$[]', '$path', '$parent']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'Persistors');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $Flash(){};
        var self = $Flash = $klass($base, $super, 'Flash', $Flash);

        var def = self._proto, $scope = self._scope;

        def.model = nil;
        def.$initialize = function(model) {
          var self = this;

          return self.model = model;
        };

        def.$added = function(model, index) {
          var $a, $b, self = this;

          if ((($a = (($b = $scope.Volt) == null ? $opal.cm('Volt') : $b)['$client?']()) !== nil && (!$a._isBoolean || $a == true))) {
            
            setTimeout(function() {
              self.$clear_model(model);
            }, 5000);
          
            } else {
            return nil
          };
        };

        return (def.$clear_model = function(model) {
          var self = this, collection_name = nil;

          self.model.$delete(model);
          if (self.model.$size()['$=='](0)) {
            collection_name = self.model.$path()['$[]'](-1);
            return self.model.$parent().$delete(collection_name);
            } else {
            return nil
          };
        }, nil) && 'clear_model';
      })(self, (($a = $scope.Base) == null ? $opal.cm('Base') : $a))
      
    })(self)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module;

  $opal.add_stubs(['$==']);
  if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
    return (function($base) {
      var self = $module($base, 'Volt');

      var def = self._proto, $scope = self._scope;

      (function($base) {
        var self = $module($base, 'LocalStorage');

        var def = self._proto, $scope = self._scope;

        $opal.defs(self, '$[]', function(key) {
          var self = this;

          
          var val = localStorage.getItem(key);
          return val === null ? nil : val;
        
        });

        $opal.defs(self, '$[]=', function(key, value) {
          var self = this;

          return localStorage.setItem(key, value);
        });

        $opal.defs(self, '$clear', function() {
          var self = this;

          localStorage.clear();
          return self;
        });

        $opal.defs(self, '$delete', function(key) {
          var self = this;

          
          var val = localStorage.getItem(key);
          localStorage.removeItem(key);
          return val === null ? nil : val;
        
        });
        
      })(self)
      
    })(self)}
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$loop', '$parent', '$save_all', '$persistor', '$root_model', '$==', '$path', '$[]', '$parse', '$each_pair', '$send', '$to_s', '$dump', '$to_h', '$[]=']);
  ;
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'Persistors');

      var def = self._proto, $scope = self._scope, $a;

      (function($base, $super) {
        function $LocalStore(){};
        var self = $LocalStore = $klass($base, $super, 'LocalStore', $LocalStore);

        var def = self._proto, $scope = self._scope;

        def.model = def.loading_data = nil;
        def.$initialize = function(model) {
          var self = this;

          return self.model = model;
        };

        def.$root_model = function() {
          var $a, $b, TMP_1, self = this, node = nil;

          node = self.model;
          ($a = ($b = self).$loop, $a._p = (TMP_1 = function(){var self = TMP_1._s || this, parent = nil;

          parent = node.$parent();
            if (parent !== false && parent !== nil) {
              return node = parent
              } else {
              return ($breaker.$v = nil, $breaker)
            };}, TMP_1._s = self, TMP_1), $a).call($b);
          return node;
        };

        def.$added = function(model, index) {
          var self = this;

          return self.$root_model().$persistor().$save_all();
        };

        def.$loaded = function(initial_state) {
          var $a, $b, TMP_2, self = this, json_data = nil, root_attributes = nil;

          if (initial_state == null) {
            initial_state = nil
          }
          if (self.model.$path()['$==']([])) {
            json_data = (($a = $scope.LocalStorage) == null ? $opal.cm('LocalStorage') : $a)['$[]']("volt-store");
            if (json_data !== false && json_data !== nil) {
              root_attributes = (($a = $scope.JSON) == null ? $opal.cm('JSON') : $a).$parse(json_data);
              self.loading_data = true;
              ($a = ($b = root_attributes).$each_pair, $a._p = (TMP_2 = function(key, value){var self = TMP_2._s || this;
                if (self.model == null) self.model = nil;
if (key == null) key = nil;if (value == null) value = nil;
              return self.model.$send(("_" + key.$to_s() + "="), value)}, TMP_2._s = self, TMP_2), $a).call($b);
              return self.loading_data = nil;
              } else {
              return nil
            };
            } else {
            return nil
          };
        };

        def.$changed = function(attribute_name) {
          var self = this;

          return self.$root_model().$persistor().$save_all();
        };

        return (def.$save_all = function() {
          var $a, self = this, json_data = nil;

          if ((($a = self.loading_data) !== nil && (!$a._isBoolean || $a == true))) {
            return nil};
          json_data = (($a = $scope.JSON) == null ? $opal.cm('JSON') : $a).$dump(self.model.$to_h());
          return (($a = $scope.LocalStorage) == null ? $opal.cm('LocalStorage') : $a)['$[]=']("volt-store", json_data);
        }, nil) && 'save_all';
      })(self, (($a = $scope.Base) == null ? $opal.cm('Base') : $a))
      
    })(self)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$resolve', '$new', '$reject', '$attr_reader', '$!', '$==', '$<<', '$>>', '$exception?', '$resolved?', '$value', '$rejected?', '$===', '$error', '$realized?', '$raise', '$^', '$call', '$resolve!', '$exception!', '$reject!', '$class', '$object_id', '$+', '$inspect', '$act?', '$prev', '$concat', '$it', '$lambda', '$reverse', '$each', '$wait', '$then', '$to_proc', '$map', '$reduce', '$always', '$try', '$tap', '$all?', '$find']);
  return (function($base, $super) {
    function $Promise(){};
    var self = $Promise = $klass($base, $super, 'Promise', $Promise);

    var def = self._proto, $scope = self._scope, TMP_1, TMP_2, TMP_3, TMP_4;

    def.success = def.exception = def.realized = def.delayed = def.failure = def.error = def.prev = def.next = def.value = nil;
    $opal.defs(self, '$value', function(value) {
      var self = this;

      return self.$new().$resolve(value);
    });

    $opal.defs(self, '$error', function(value) {
      var self = this;

      return self.$new().$reject(value);
    });

    $opal.defs(self, '$when', function(promises) {
      var $a, self = this;

      promises = $slice.call(arguments, 0);
      return (($a = $scope.When) == null ? $opal.cm('When') : $a).$new(promises);
    });

    self.$attr_reader("value", "error", "prev", "next");

    def.$initialize = function(success, failure) {
      var self = this;

      if (success == null) {
        success = nil
      }
      if (failure == null) {
        failure = nil
      }
      self.success = success;
      self.failure = failure;
      self.realized = nil;
      self.exception = false;
      self.value = nil;
      self.error = nil;
      self.delayed = nil;
      self.prev = nil;
      return self.next = nil;
    };

    def['$act?'] = function() {
      var self = this;

      return self.success['$=='](nil)['$!']();
    };

    def['$exception?'] = function() {
      var self = this;

      return self.exception;
    };

    def['$realized?'] = function() {
      var self = this;

      return self.realized['$=='](nil)['$!']();
    };

    def['$resolved?'] = function() {
      var self = this;

      return self.realized['$==']("resolve");
    };

    def['$rejected?'] = function() {
      var self = this;

      return self.realized['$==']("reject");
    };

    def['$^'] = function(promise) {
      var self = this;

      promise['$<<'](self);
      self['$>>'](promise);
      return promise;
    };

    def['$<<'] = function(promise) {
      var self = this;

      self.prev = promise;
      return self;
    };

    def['$>>'] = function(promise) {
      var $a, $b, $c, $d, self = this;

      self.next = promise;
      if ((($a = self['$exception?']()) !== nil && (!$a._isBoolean || $a == true))) {
        promise.$reject(self.delayed)
      } else if ((($a = self['$resolved?']()) !== nil && (!$a._isBoolean || $a == true))) {
        promise.$resolve(((($a = self.delayed) !== false && $a !== nil) ? $a : self.$value()))
      } else if ((($a = ($b = self['$rejected?'](), $b !== false && $b !== nil ?(((($c = self.failure['$!']()) !== false && $c !== nil) ? $c : (($d = $scope.Promise) == null ? $opal.cm('Promise') : $d)['$===']((((($d = self.delayed) !== false && $d !== nil) ? $d : self.error))))) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        promise.$reject(((($a = self.delayed) !== false && $a !== nil) ? $a : self.$error()))};
      return self;
    };

    def.$resolve = function(value) {
      var $a, $b, self = this, e = nil;

      if (value == null) {
        value = nil
      }
      if ((($a = self['$realized?']()) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "the promise has already been realized")};
      if ((($a = (($b = $scope.Promise) == null ? $opal.cm('Promise') : $b)['$==='](value)) !== nil && (!$a._isBoolean || $a == true))) {
        value['$<<'](self.prev);
        return value['$^'](self);};
      self.realized = "resolve";
      self.value = value;
      try {
      if ((($a = self.success) !== nil && (!$a._isBoolean || $a == true))) {
          value = self.success.$call(value)};
        self['$resolve!'](value);
      } catch ($err) {if ($opal.$rescue($err, [(($a = $scope.Exception) == null ? $opal.cm('Exception') : $a)])) {e = $err;
        self['$exception!'](e)
        }else { throw $err; }
      };
      return self;
    };

    def['$resolve!'] = function(value) {
      var $a, self = this;

      if ((($a = self.next) !== nil && (!$a._isBoolean || $a == true))) {
        return self.next.$resolve(value)
        } else {
        return self.delayed = value
      };
    };

    def.$reject = function(value) {
      var $a, $b, self = this, e = nil;

      if (value == null) {
        value = nil
      }
      if ((($a = self['$realized?']()) !== nil && (!$a._isBoolean || $a == true))) {
        self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "the promise has already been realized")};
      if ((($a = (($b = $scope.Promise) == null ? $opal.cm('Promise') : $b)['$==='](value)) !== nil && (!$a._isBoolean || $a == true))) {
        value['$<<'](self.prev);
        return value['$^'](self);};
      self.realized = "reject";
      self.error = value;
      try {
      if ((($a = self.failure) !== nil && (!$a._isBoolean || $a == true))) {
          value = self.failure.$call(value);
          if ((($a = (($b = $scope.Promise) == null ? $opal.cm('Promise') : $b)['$==='](value)) !== nil && (!$a._isBoolean || $a == true))) {
            self['$reject!'](value)};
          } else {
          self['$reject!'](value)
        }
      } catch ($err) {if ($opal.$rescue($err, [(($a = $scope.Exception) == null ? $opal.cm('Exception') : $a)])) {e = $err;
        self['$exception!'](e)
        }else { throw $err; }
      };
      return self;
    };

    def['$reject!'] = function(value) {
      var $a, self = this;

      if ((($a = self.next) !== nil && (!$a._isBoolean || $a == true))) {
        return self.next.$reject(value)
        } else {
        return self.delayed = value
      };
    };

    def['$exception!'] = function(error) {
      var self = this;

      self.exception = true;
      return self['$reject!'](error);
    };

    def.$then = TMP_1 = function() {
      var $a, self = this, $iter = TMP_1._p, block = $iter || nil;

      TMP_1._p = null;
      return self['$^']((($a = $scope.Promise) == null ? $opal.cm('Promise') : $a).$new(block));
    };

    $opal.defn(self, '$do', def.$then);

    def.$fail = TMP_2 = function() {
      var $a, self = this, $iter = TMP_2._p, block = $iter || nil;

      TMP_2._p = null;
      return self['$^']((($a = $scope.Promise) == null ? $opal.cm('Promise') : $a).$new(nil, block));
    };

    $opal.defn(self, '$rescue', def.$fail);

    $opal.defn(self, '$catch', def.$fail);

    def.$always = TMP_3 = function() {
      var $a, self = this, $iter = TMP_3._p, block = $iter || nil;

      TMP_3._p = null;
      return self['$^']((($a = $scope.Promise) == null ? $opal.cm('Promise') : $a).$new(block, block));
    };

    $opal.defn(self, '$finally', def.$always);

    $opal.defn(self, '$ensure', def.$always);

    def.$trace = TMP_4 = function() {
      var $a, self = this, $iter = TMP_4._p, block = $iter || nil;

      TMP_4._p = null;
      return self['$^']((($a = $scope.Trace) == null ? $opal.cm('Trace') : $a).$new(block));
    };

    def.$inspect = function() {
      var $a, self = this, result = nil;

      result = "#<" + (self.$class()) + "(" + (self.$object_id()) + ")";
      if ((($a = self.next) !== nil && (!$a._isBoolean || $a == true))) {
        result = result['$+'](" >> " + (self.next.$inspect()))};
      if ((($a = self['$realized?']()) !== nil && (!$a._isBoolean || $a == true))) {
        result = result['$+'](": " + ((((($a = self.value) !== false && $a !== nil) ? $a : self.error)).$inspect()) + ">")
        } else {
        result = result['$+'](">")
      };
      return result;
    };

    (function($base, $super) {
      function $Trace(){};
      var self = $Trace = $klass($base, $super, 'Trace', $Trace);

      var def = self._proto, $scope = self._scope, TMP_6;

      $opal.defs(self, '$it', function(promise) {
        var $a, self = this, current = nil, prev = nil;

        if ((($a = promise['$realized?']()) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "the promise hasn't been realized")
        };
        current = (function() {if ((($a = promise['$act?']()) !== nil && (!$a._isBoolean || $a == true))) {
          return [promise.$value()]
          } else {
          return []
        }; return nil; })();
        if ((($a = prev = promise.$prev()) !== nil && (!$a._isBoolean || $a == true))) {
          return current.$concat(self.$it(prev))
          } else {
          return current
        };
      });

      return (def.$initialize = TMP_6 = function(block) {
        var $a, $b, TMP_5, self = this, $iter = TMP_6._p, $yield = $iter || nil;

        TMP_6._p = null;
        return $opal.find_super_dispatcher(self, 'initialize', TMP_6, null).apply(self, [($a = ($b = self).$lambda, $a._p = (TMP_5 = function(){var self = TMP_5._s || this, $a, $b;

        return ($a = block).$call.apply($a, [].concat((($b = $scope.Trace) == null ? $opal.cm('Trace') : $b).$it(self).$reverse()))}, TMP_5._s = self, TMP_5), $a).call($b)]);
      }, nil) && 'initialize';
    })(self, self);

    return (function($base, $super) {
      function $When(){};
      var self = $When = $klass($base, $super, 'When', $When);

      var def = self._proto, $scope = self._scope, TMP_7, TMP_9, TMP_11, TMP_13, TMP_17;

      def.wait = nil;
      def.$initialize = TMP_7 = function(promises) {
        var $a, $b, TMP_8, self = this, $iter = TMP_7._p, $yield = $iter || nil;

        if (promises == null) {
          promises = []
        }
        TMP_7._p = null;
        $opal.find_super_dispatcher(self, 'initialize', TMP_7, null).apply(self, []);
        self.wait = [];
        return ($a = ($b = promises).$each, $a._p = (TMP_8 = function(promise){var self = TMP_8._s || this;
if (promise == null) promise = nil;
        return self.$wait(promise)}, TMP_8._s = self, TMP_8), $a).call($b);
      };

      def.$each = TMP_9 = function() {
        var $a, $b, TMP_10, self = this, $iter = TMP_9._p, block = $iter || nil;

        TMP_9._p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "no block given")
        };
        return ($a = ($b = self).$then, $a._p = (TMP_10 = function(values){var self = TMP_10._s || this, $a, $b;
if (values == null) values = nil;
        return ($a = ($b = values).$each, $a._p = block.$to_proc(), $a).call($b)}, TMP_10._s = self, TMP_10), $a).call($b);
      };

      def.$collect = TMP_11 = function() {
        var $a, $b, TMP_12, self = this, $iter = TMP_11._p, block = $iter || nil;

        TMP_11._p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise((($a = $scope.ArgumentError) == null ? $opal.cm('ArgumentError') : $a), "no block given")
        };
        return ($a = ($b = self).$then, $a._p = (TMP_12 = function(values){var self = TMP_12._s || this, $a, $b;
if (values == null) values = nil;
        return (($a = $scope.When) == null ? $opal.cm('When') : $a).$new(($a = ($b = values).$map, $a._p = block.$to_proc(), $a).call($b))}, TMP_12._s = self, TMP_12), $a).call($b);
      };

      def.$inject = TMP_13 = function(args) {
        var $a, $b, TMP_14, self = this, $iter = TMP_13._p, block = $iter || nil;

        args = $slice.call(arguments, 0);
        TMP_13._p = null;
        return ($a = ($b = self).$then, $a._p = (TMP_14 = function(values){var self = TMP_14._s || this, $a, $b;
if (values == null) values = nil;
        return ($a = ($b = values).$reduce, $a._p = block.$to_proc(), $a).apply($b, [].concat(args))}, TMP_14._s = self, TMP_14), $a).call($b);
      };

      $opal.defn(self, '$map', def.$collect);

      $opal.defn(self, '$reduce', def.$inject);

      def.$wait = function(promise) {
        var $a, $b, TMP_15, self = this;

        if ((($a = (($b = $scope.Promise) == null ? $opal.cm('Promise') : $b)['$==='](promise)) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          promise = (($a = $scope.Promise) == null ? $opal.cm('Promise') : $a).$value(promise)
        };
        if ((($a = promise['$act?']()) !== nil && (!$a._isBoolean || $a == true))) {
          promise = promise.$then()};
        self.wait['$<<'](promise);
        ($a = ($b = promise).$always, $a._p = (TMP_15 = function(){var self = TMP_15._s || this, $a;
          if (self.next == null) self.next = nil;

        if ((($a = self.next) !== nil && (!$a._isBoolean || $a == true))) {
            return self.$try()
            } else {
            return nil
          }}, TMP_15._s = self, TMP_15), $a).call($b);
        return self;
      };

      $opal.defn(self, '$and', def.$wait);

      def['$>>'] = TMP_17 = function() {var $zuper = $slice.call(arguments, 0);
        var $a, $b, TMP_16, self = this, $iter = TMP_17._p, $yield = $iter || nil;

        TMP_17._p = null;
        return ($a = ($b = $opal.find_super_dispatcher(self, '>>', TMP_17, $iter).apply(self, $zuper)).$tap, $a._p = (TMP_16 = function(){var self = TMP_16._s || this;

        return self.$try()}, TMP_16._s = self, TMP_16), $a).call($b);
      };

      return (def.$try = function() {
        var $a, $b, $c, $d, self = this, promise = nil;

        if ((($a = ($b = ($c = self.wait)['$all?'], $b._p = "realized?".$to_proc(), $b).call($c)) !== nil && (!$a._isBoolean || $a == true))) {
          if ((($a = promise = ($b = ($d = self.wait).$find, $b._p = "rejected?".$to_proc(), $b).call($d)) !== nil && (!$a._isBoolean || $a == true))) {
            return self.$reject(promise.$error())
            } else {
            return self.$resolve(($a = ($b = self.wait).$map, $a._p = "value".$to_proc(), $a).call($b))
          }
          } else {
          return nil
        };
      }, nil) && 'try';
    })(self, self);
  })(self, null)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice;

  $opal.add_stubs(['$==']);
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
    };
  ;
  ;
  if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
    return true};
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module;

  $opal.add_stubs(['$instance_variable_get', '$to_s', '$instance_variable_set', '$new', '$each', '$define_method', '$depend', '$__reactive_dependency_get', '$class', '$to_sym', '$changed!', '$reactive_reader', '$reactive_writer', '$send']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'ReactiveAccessors');

      var def = self._proto, $scope = self._scope;

      (function($base) {
        var self = $module($base, 'ClassMethods');

        var def = self._proto, $scope = self._scope;

        def.$__reactive_dependency_get = function(var_name) {
          var $a, $b, self = this, value_dep = nil;

          value_dep = self.$instance_variable_get(("@__" + var_name.$to_s() + "_dependency"));
          return ((($a = value_dep) !== false && $a !== nil) ? $a : value_dep = self.$instance_variable_set(("@__" + var_name.$to_s() + "_dependency"), (($b = $scope.Dependency) == null ? $opal.cm('Dependency') : $b).$new()));
        };

        def.$reactive_reader = function(names) {
          var $a, $b, TMP_1, self = this;

          names = $slice.call(arguments, 0);
          return ($a = ($b = names).$each, $a._p = (TMP_1 = function(name){var self = TMP_1._s || this, $a, $b, TMP_2, var_name = nil;
if (name == null) name = nil;
          var_name = ("@" + name.$to_s());
            return ($a = ($b = self).$define_method, $a._p = (TMP_2 = function(){var self = TMP_2._s || this, value = nil;

            value = self.$instance_variable_get(var_name);
              self.$class().$__reactive_dependency_get(name).$depend();
              return value;}, TMP_2._s = self, TMP_2), $a).call($b, name.$to_sym());}, TMP_1._s = self, TMP_1), $a).call($b);
        };

        def.$reactive_writer = function(names) {
          var $a, $b, TMP_3, self = this;

          names = $slice.call(arguments, 0);
          return ($a = ($b = names).$each, $a._p = (TMP_3 = function(name){var self = TMP_3._s || this, $a, $b, TMP_4, var_name = nil;
if (name == null) name = nil;
          var_name = ("@" + name.$to_s());
            return ($a = ($b = self).$define_method, $a._p = (TMP_4 = function(new_value){var self = TMP_4._s || this;
if (new_value == null) new_value = nil;
            self.$instance_variable_set(var_name, new_value);
              return self.$class().$__reactive_dependency_get(name)['$changed!']();}, TMP_4._s = self, TMP_4), $a).call($b, ("" + name.$to_s() + "="));}, TMP_3._s = self, TMP_3), $a).call($b);
        };

        def.$reactive_accessor = function(names) {
          var $a, $b, self = this;

          names = $slice.call(arguments, 0);
          ($a = self).$reactive_reader.apply($a, [].concat(names));
          return ($b = self).$reactive_writer.apply($b, [].concat(names));
        };
                ;$opal.donate(self, ["$__reactive_dependency_get", "$reactive_reader", "$reactive_writer", "$reactive_accessor"]);
      })(self);

      $opal.defs(self, '$included', function(base) {
        var $a, self = this;

        return base.$send("extend", (($a = $scope.ClassMethods) == null ? $opal.cm('ClassMethods') : $a));
      });
      
    })(self)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $gvars = $opal.gvars;

  $opal.add_stubs(['$include', '$reactive_accessor', '$current_model', '$current_model=', '$new', '$===', '$include?', '$to_sym', '$send', '$fail', '$join', '$is_a?', '$call', '$allocate', '$model=', '$to_proc', '$attr_accessor', '$[]', '$attrs=', '$respond_to?', '$attrs', '$locals', '$parse', '$url', '$page', '$store', '$flash', '$params', '$local_store', '$cookies', '$channel', '$tasks', '$url_for', '$url_with', '$==', '$state', '$model']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $ModelController(){};
      var self = $ModelController = $klass($base, $super, 'ModelController', $ModelController);

      var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_2, TMP_3;

      def.controller = nil;
      self.$include((($a = $scope.ReactiveAccessors) == null ? $opal.cm('ReactiveAccessors') : $a));

      self.$reactive_accessor("current_model");

      $opal.defs(self, '$model', function(val) {
        var self = this;

        return self.default_model = val;
      });

      def['$model='] = function(val) {
        var $a, $b, $c, self = this, collections = nil;

        ($a = self, ((($b = $a.$current_model()) !== false && $b !== nil) ? $b : $a['$current_model=']((($c = $scope.Model) == null ? $opal.cm('Model') : $c).$new())));
        if ((($a = ((($b = (($c = $scope.Symbol) == null ? $opal.cm('Symbol') : $c)['$==='](val)) !== false && $b !== nil) ? $b : (($c = $scope.String) == null ? $opal.cm('String') : $c)['$==='](val))) !== nil && (!$a._isBoolean || $a == true))) {
          collections = ["page", "store", "params", "controller"];
          if ((($a = collections['$include?'](val.$to_sym())) !== nil && (!$a._isBoolean || $a == true))) {
            return self['$current_model='](self.$send(val))
            } else {
            return self.$fail("" + (val) + " is not the name of a valid model, choose from: " + (collections.$join(", ")))
          };
          } else {
          return self['$current_model='](val)
        };
      };

      def.$model = function() {
        var $a, $b, $c, self = this, model = nil;

        model = self.$current_model();
        if ((($a = (($b = model !== false && model !== nil) ? model['$is_a?']((($c = $scope.Proc) == null ? $opal.cm('Proc') : $c)) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          model = model.$call()};
        return model;
      };

      $opal.defs(self, '$new', TMP_1 = function(args) {
        var $a, $b, self = this, $iter = TMP_1._p, block = $iter || nil, inst = nil;
        if (self.default_model == null) self.default_model = nil;

        args = $slice.call(arguments, 0);
        TMP_1._p = null;
        inst = self.$allocate();
        if ((($a = self.default_model) !== nil && (!$a._isBoolean || $a == true))) {
          inst['$model='](self.default_model)};
        ($a = ($b = inst).$send, $a._p = block.$to_proc(), $a).apply($b, ["initialize"].concat(args));
        return inst;
      });

      self.$attr_accessor("attrs");

      def.$initialize = function(args) {
        var $a, self = this;

        args = $slice.call(arguments, 0);
        if ((($a = args['$[]'](0)) !== nil && (!$a._isBoolean || $a == true))) {
          self['$attrs='](args['$[]'](0));
          if ((($a = self.$attrs()['$respond_to?']("model")) !== nil && (!$a._isBoolean || $a == true))) {
            return self['$model='](self.$attrs().$locals()['$[]']("model"))
            } else {
            return nil
          };
          } else {
          return nil
        };
      };

      def.$go = function(url) {
        var self = this;

        return self.$url().$parse(url);
      };

      def.$page = function() {
        var self = this;
        if ($gvars.page == null) $gvars.page = nil;

        return $gvars.page.$page();
      };

      def.$store = function() {
        var self = this;
        if ($gvars.page == null) $gvars.page = nil;

        return $gvars.page.$store();
      };

      def.$flash = function() {
        var self = this;
        if ($gvars.page == null) $gvars.page = nil;

        return $gvars.page.$flash();
      };

      def.$params = function() {
        var self = this;
        if ($gvars.page == null) $gvars.page = nil;

        return $gvars.page.$params();
      };

      def.$local_store = function() {
        var self = this;
        if ($gvars.page == null) $gvars.page = nil;

        return $gvars.page.$local_store();
      };

      def.$cookies = function() {
        var self = this;
        if ($gvars.page == null) $gvars.page = nil;

        return $gvars.page.$cookies();
      };

      def.$url = function() {
        var self = this;
        if ($gvars.page == null) $gvars.page = nil;

        return $gvars.page.$url();
      };

      def.$channel = function() {
        var self = this;
        if ($gvars.page == null) $gvars.page = nil;

        return $gvars.page.$channel();
      };

      def.$tasks = function() {
        var self = this;
        if ($gvars.page == null) $gvars.page = nil;

        return $gvars.page.$tasks();
      };

      def.$controller = function() {
        var $a, $b, self = this;

        return ((($a = self.controller) !== false && $a !== nil) ? $a : self.controller = (($b = $scope.Model) == null ? $opal.cm('Model') : $b).$new());
      };

      def.$url_for = function(params) {
        var self = this;
        if ($gvars.page == null) $gvars.page = nil;

        return $gvars.page.$url().$url_for(params);
      };

      def.$url_with = function(params) {
        var self = this;
        if ($gvars.page == null) $gvars.page = nil;

        return $gvars.page.$url().$url_with(params);
      };

      def['$loaded?'] = function() {
        var $a, self = this;

        return ($a = self['$respond_to?']("state"), $a !== false && $a !== nil ?self.$state()['$==']("loaded") : $a);
      };

      def['$respond_to?'] = TMP_2 = function(method_name) {var $zuper = $slice.call(arguments, 0);
        var $a, self = this, $iter = TMP_2._p, $yield = $iter || nil, model = nil;

        TMP_2._p = null;
        return ((($a = $opal.find_super_dispatcher(self, 'respond_to?', TMP_2, $iter).apply(self, $zuper)) !== false && $a !== nil) ? $a : (function() {model = self.$model();
        if (model !== false && model !== nil) {
          return model['$respond_to?'](method_name)
          } else {
          return nil
        };})());
      };

      return (def.$method_missing = TMP_3 = function(method_name, args) {var $zuper = $slice.call(arguments, 0);
        var $a, $b, self = this, $iter = TMP_3._p, block = $iter || nil, model = nil;

        args = $slice.call(arguments, 1);
        TMP_3._p = null;
        model = self.$model();
        if (model !== false && model !== nil) {
          return ($a = ($b = model).$send, $a._p = block.$to_proc(), $a).apply($b, [method_name].concat(args))
          } else {
          return $opal.find_super_dispatcher(self, 'method_missing', TMP_3, $iter).apply(self, $zuper)
        };
      }, nil) && 'method_missing';
    })(self, null)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2, $gvars = $opal.gvars;

  $opal.add_stubs(['$==', '$_user_id', '$cookies', '$nil?', '$[]=', '$call', '$to_proc', '$tasks', '$name']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $TaskHandler(){};
      var self = $TaskHandler = $klass($base, $super, 'TaskHandler', $TaskHandler);

      var def = self._proto, $scope = self._scope, $a, TMP_1;

      if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
        return ($opal.defs(self, '$method_missing', TMP_1 = function(name, args) {
          var $a, $b, self = this, $iter = TMP_1._p, block = $iter || nil, meta_data = nil, user_id = nil;
          if ($gvars.page == null) $gvars.page = nil;

          args = $slice.call(arguments, 1);
          TMP_1._p = null;
          meta_data = $hash2([], {});
          user_id = $gvars.page.$cookies().$_user_id();
          if ((($a = user_id['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            meta_data['$[]=']("user_id", user_id)
          };
          return ($a = ($b = $gvars.page.$tasks()).$call, $a._p = block.$to_proc(), $a).apply($b, [self.$name(), name, meta_data].concat(args));
        }), nil) && 'method_missing'}
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$attr_accessor', '$dom_section', '$target', '$remove', '$remove_anchors']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $BaseBinding(){};
      var self = $BaseBinding = $klass($base, $super, 'BaseBinding', $BaseBinding);

      var def = self._proto, $scope = self._scope;

      def.dom_section = def.binding_name = nil;
      self.$attr_accessor("target", "context", "binding_name");

      def.$initialize = function(page, target, context, binding_name) {
        var $a, $b, self = this;

        self.page = page;
        self.target = target;
        self.context = context;
        self.binding_name = binding_name;
        return ((($a = (($b = $opal.cvars['@@binding_number']) == null ? nil : $b)) !== false && $a !== nil) ? $a : ($opal.cvars['@@binding_number'] = 10000));
      };

      def.$dom_section = function() {
        var $a, self = this;

        return ((($a = self.dom_section) !== false && $a !== nil) ? $a : self.dom_section = self.$target().$dom_section(self.binding_name));
      };

      def.$remove = function() {
        var $a, self = this;

        if ((($a = self.dom_section) !== nil && (!$a._isBoolean || $a == true))) {
          self.dom_section.$remove()};
        self.target = nil;
        self.context = nil;
        return self.dom_section = nil;
      };

      return (def.$remove_anchors = function() {
        var $a, self = this;

        if ((($a = self.dom_section) !== nil && (!$a._isBoolean || $a == true))) {
          return self.dom_section.$remove_anchors()
          } else {
          return nil
        };
      }, nil) && 'remove_anchors';
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module;

  $opal.add_stubs(['$==', '$find_by_comment_without_xml']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base) {
      var self = $module($base, 'CommentSearchers');

      var def = self._proto, $scope = self._scope, $a;

      if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
        $opal.cdecl($scope, 'NO_XPATH', !!window._phantom || !document.evaluate)};

      def.$find_by_comment = function(text, in_node) {
        var $a, $b, self = this, node = nil;

        if (in_node == null) {
          in_node = document
        }
        if ((($a = (($b = $scope.NO_XPATH) == null ? $opal.cm('NO_XPATH') : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          return self.$find_by_comment_without_xml(text, in_node)
          } else {
          node = nil;
          
          node = document.evaluate("//comment()[. = ' " + text + " ']", in_node, null, XPathResult.UNORDERED_NODE_ITERATOR_TYPE, null).iterateNext();
        
          return node;
        };
      };

      def.$find_by_comment_without_xml = function(text, in_node) {
        var self = this, match_text = nil;

        match_text = " " + (text) + " ";
        
        function walk(node) {
          if (node.nodeType === 8 && node.nodeValue === match_text) {
            return node;
          }

          var children = node.childNodes;
          if (children) {
            for (var i=0;i < children.length;i++) {
              var matched = walk(children[i]);
              if (matched) {
                return matched;
              }
            }
          }

          return null;
        }


        return walk(in_node);

      
      };

      def.$build_from_html = function(html) {
        var self = this, temp_div = nil;

        temp_div = nil;
        
        temp_div = document.createElement('div');
        var doc = jQuery.parseHTML(html);

        if (doc) {
          for (var i=0;i < doc.length;i++) {
            temp_div.appendChild(doc[i]);
          }
        }
      
        return temp_div;
      };
            ;$opal.donate(self, ["$find_by_comment", "$find_by_comment_without_xml", "$build_from_html"]);
    })(self)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2, $range = $opal.range;

  $opal.add_stubs(['$include', '$[]', '$templates', '$html_inspect', '$inspect', '$build_from_html', '$track_binding_anchors', '$update_binding_anchors!', '$each_pair', '$is_a?', '$[]=', '$find_by_comment', '$+', '$==']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $DomTemplate(){};
      var self = $DomTemplate = $klass($base, $super, 'DomTemplate', $DomTemplate);

      var def = self._proto, $scope = self._scope, $a;

      def.bindings = def.binding_anchors = nil;
      self.$include((($a = $scope.CommentSearchers) == null ? $opal.cm('CommentSearchers') : $a));

      def.$initialize = function(page, template_name) {
        var self = this, template = nil, html = nil;

        template = page.$templates()['$[]'](template_name);
        if (template !== false && template !== nil) {
          html = template['$[]']("html");
          self.bindings = template['$[]']("bindings");
          } else {
          html = "<div>-- &lt; missing template " + (template_name.$inspect().$html_inspect()) + ", make sure it's component is included in dependencies.rb &gt; --</div>";
          self.bindings = $hash2([], {});
        };
        self.nodes = self.$build_from_html(html);
        return self.$track_binding_anchors();
      };

      def.$make_new = function() {
        var self = this, bindings = nil, new_nodes = nil;

        bindings = self['$update_binding_anchors!'](self.nodes);
        new_nodes = self.nodes.cloneNode(true);
        return [new_nodes, bindings];
      };

      def.$track_binding_anchors = function() {
        var $a, $b, TMP_1, self = this;

        self.binding_anchors = $hash2([], {});
        return ($a = ($b = self.bindings).$each_pair, $a._p = (TMP_1 = function(name, binding){var self = TMP_1._s || this, $a, $b, node = nil, start_comment = nil, end_comment = nil;
          if (self.binding_anchors == null) self.binding_anchors = nil;
          if (self.nodes == null) self.nodes = nil;
if (name == null) name = nil;if (binding == null) binding = nil;
        if ((($a = name['$is_a?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            node = nil;
            
            node = self.nodes.querySelector('#' + name);
          
            return self.binding_anchors['$[]='](name, node);
            } else {
            start_comment = self.$find_by_comment("$" + (name), self.nodes);
            end_comment = self.$find_by_comment("$/" + (name), self.nodes);
            return self.binding_anchors['$[]='](name, [start_comment, end_comment]);
          }}, TMP_1._s = self, TMP_1), $a).call($b);
      };

      return (def['$update_binding_anchors!'] = function(nodes) {
        var $a, $b, TMP_2, self = this, new_bindings = nil;

        new_bindings = $hash2([], {});
        ($a = ($b = self.binding_anchors).$each_pair, $a._p = (TMP_2 = function(name, anchors){var self = TMP_2._s || this, $a, $b, new_name = nil, start_comment = nil, end_comment = nil;
          if (self.bindings == null) self.bindings = nil;
if (name == null) name = nil;if (anchors == null) anchors = nil;
        new_name = (($a = $opal.cvars['@@binding_number']) == null ? nil : $a);
          ($opal.cvars['@@binding_number'] = (($a = $opal.cvars['@@binding_number']) == null ? nil : $a)['$+'](1));
          if ((($a = name['$is_a?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            if (name['$[]']($range(0, 1, false))['$==']("id")) {
              anchors.setAttribute('id', 'id' + new_name);
              return new_bindings['$[]=']("id" + (new_name), self.bindings['$[]'](name));
              } else {
              return new_bindings['$[]='](name, self.bindings['$[]'](name))
            }
            } else {
            $a = $opal.to_ary(anchors), start_comment = ($a[0] == null ? nil : $a[0]), end_comment = ($a[1] == null ? nil : $a[1]);
            
            if (start_comment.textContent) {
              // direct update
              start_comment.textContent = " $" + new_name + " ";
              end_comment.textContent = " $/" + new_name + " ";
            } else if (start_comment.innerText) {
              start_comment.innerText = " $" + new_name + " ";
              end_comment.innerText = " $/" + new_name + " ";
            } else {
              // phantomjs doesn't work with textContent, so we replace the nodes
              // and update the references
              start_comment.nodeValue = " $" + new_name + " ";
              end_comment.nodeValue = " $/" + new_name + " ";
            }
          
            return new_bindings['$[]='](new_name, self.bindings['$[]'](name));
          };}, TMP_2._s = self, TMP_2), $a).call($b);
        return new_bindings;
      }, nil) && 'update_binding_anchors!';
    })(self, null)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$fail', '$is_a?', '$[]', '$[]=', '$new', '$set_template', '$templates', '$html_inspect', '$inspect', '$set_content_and_rezero_bindings']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $BaseSection(){};
      var self = $BaseSection = $klass($base, $super, 'BaseSection', $BaseSection);

      var def = self._proto, $scope = self._scope;

      ($opal.cvars['@@template_cache'] = $hash2([], {}));

      def.$remove = function() {
        var self = this;

        return self.$fail("not implemented");
      };

      def.$remove_anchors = function() {
        var self = this;

        return self.$fail("not implemented");
      };

      def.$insert_anchor_before_end = function() {
        var self = this;

        return self.$fail("not implemented");
      };

      return (def.$set_content_to_template = function(page, template_name) {
        var $a, $b, $c, $d, self = this, dom_template = nil, template = nil, html = nil, bindings = nil;

        if ((($a = self['$is_a?']((($b = $scope.DomSection) == null ? $opal.cm('DomSection') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
          dom_template = (($a = template_name, $b = (($c = $opal.cvars['@@template_cache']) == null ? nil : $c), ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, (($d = $scope.DomTemplate) == null ? $opal.cm('DomTemplate') : $d).$new(page, template_name)))));
          return self.$set_template(dom_template);
          } else {
          template = page.$templates()['$[]'](template_name);
          if (template !== false && template !== nil) {
            html = template['$[]']("html");
            bindings = template['$[]']("bindings");
            } else {
            html = "<div>-- &lt; missing template " + (template_name.$inspect().$html_inspect()) + ", make sure it's component is included in dependencies.rb &gt; --</div>";
            bindings = $hash2([], {});
          };
          return self.$set_content_and_rezero_bindings(html, bindings);
        };
      }, nil) && 'set_content_to_template';
    })(self, null)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$set_content_and_rezero_bindings', '$==', '$html=', '$find_by_binding_id', '$remove']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $AttributeSection(){};
      var self = $AttributeSection = $klass($base, $super, 'AttributeSection', $AttributeSection);

      var def = self._proto, $scope = self._scope;

      def.binding_name = def.target = nil;
      def.$initialize = function(target, binding_name) {
        var self = this;

        self.target = target;
        return self.binding_name = binding_name;
      };

      def['$text='] = function(text) {
        var self = this;

        return self.$set_content_and_rezero_bindings(text, $hash2([], {}));
      };

      def['$html='] = function(value) {
        var self = this;

        return self.$set_content_and_rezero_bindings(value, $hash2([], {}));
      };

      def.$set_content_and_rezero_bindings = function(html, bindings) {
        var self = this;

        if (self.binding_name['$==']("main")) {
          self.target['$html='](html)
          } else {
          self.target.$find_by_binding_id(self.binding_name)['$html='](html)
        };
        return bindings;
      };

      return (def.$remove = function() {
        var self = this, node = nil;

        node = self.target.$find_by_binding_id(self.binding_name);
        if (node !== false && node !== nil) {
          return node.$remove()
          } else {
          return nil
        };
      }, nil) && 'remove';
    })(self, (($a = $scope.BaseSection) == null ? $opal.cm('BaseSection') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs([]);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $BaseNode(){};
      var self = $BaseNode = $klass($base, $super, 'BaseNode', $BaseNode);

      var def = self._proto, $scope = self._scope;

      return nil;
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$inspect']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $HtmlNode(){};
      var self = $HtmlNode = $klass($base, $super, 'HtmlNode', $HtmlNode);

      var def = self._proto, $scope = self._scope;

      def.html = nil;
      def.$initialize = function(html) {
        var self = this;

        return self.html = html;
      };

      def.$to_html = function() {
        var self = this;

        return self.html;
      };

      return (def.$inspect = function() {
        var self = this;

        return "<HtmlNode " + (self.html.$inspect()) + ">";
      }, nil) && 'inspect';
    })(self, (($a = $scope.BaseNode) == null ? $opal.cm('BaseNode') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$attr_accessor', '$changed!', '$trigger!', '$html=', '$reject', '$==', '$split', '$each', '$===', '$to_i', '$[]', '$match', '$new', '$<<', '$parent', '$to_html', '$join', '$is_a?', '$find_by_binding_id', '$fail', '$delete', '$nodes', '$inspect']);
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $ComponentNode(){};
      var self = $ComponentNode = $klass($base, $super, 'ComponentNode', $ComponentNode);

      var def = self._proto, $scope = self._scope, $a;

      def.root = def.nodes = def.binding_id = def.parent = nil;
      self.$include((($a = $scope.Eventable) == null ? $opal.cm('Eventable') : $a));

      self.$attr_accessor("parent", "binding_id", "nodes");

      def.$initialize = function(binding_id, parent, root) {
        var self = this;

        if (binding_id == null) {
          binding_id = nil
        }
        if (parent == null) {
          parent = nil
        }
        if (root == null) {
          root = nil
        }
        self.nodes = [];
        self.binding_id = binding_id;
        self.parent = parent;
        return self.root = root;
      };

      def['$changed!'] = function() {
        var $a, self = this;

        if ((($a = self.root) !== nil && (!$a._isBoolean || $a == true))) {
          return self.root['$changed!']()
          } else {
          return self['$trigger!']("changed")
        };
      };

      def['$text='] = function(text) {
        var self = this;

        return self['$html='](text);
      };

      def['$html='] = function(html) {
        var $a, $b, TMP_1, $c, TMP_2, self = this, parts = nil, current_node = nil;

        parts = ($a = ($b = html.$split(/(\<\!\-\- \$\/?[0-9]+ \-\-\>)/)).$reject, $a._p = (TMP_1 = function(v){var self = TMP_1._s || this;
if (v == null) v = nil;
        return v['$==']("")}, TMP_1._s = self, TMP_1), $a).call($b);
        self.nodes = [];
        current_node = self;
        ($a = ($c = parts).$each, $a._p = (TMP_2 = function(part){var self = TMP_2._s || this, $a, $case = nil, binding_id = nil, sub_node = nil;
          if (self.root == null) self.root = nil;
if (part == null) part = nil;
        return (function() {$case = part;if (/\<\!\-\- \$[0-9]+ \-\-\>/['$===']($case)) {binding_id = part.$match(/\<\!\-\- \$([0-9]+) \-\-\>/)['$[]'](1).$to_i();
          sub_node = (($a = $scope.ComponentNode) == null ? $opal.cm('ComponentNode') : $a).$new(binding_id, current_node, ((($a = self.root) !== false && $a !== nil) ? $a : self));
          current_node['$<<'](sub_node);
          return current_node = sub_node;}else if (/\<\!\-\- \$\/[0-9]+ \-\-\>/['$===']($case)) {return current_node = current_node.$parent()}else {return current_node['$<<']((($a = $scope.HtmlNode) == null ? $opal.cm('HtmlNode') : $a).$new(part))}})()}, TMP_2._s = self, TMP_2), $a).call($c);
        return self['$changed!']();
      };

      def['$<<'] = function(node) {
        var self = this;

        return self.nodes['$<<'](node);
      };

      def.$to_html = function() {
        var $a, $b, TMP_3, self = this, str = nil;

        str = [];
        ($a = ($b = self.nodes).$each, $a._p = (TMP_3 = function(node){var self = TMP_3._s || this;
if (node == null) node = nil;
        return str['$<<'](node.$to_html())}, TMP_3._s = self, TMP_3), $a).call($b);
        return str.$join("");
      };

      def.$find_by_binding_id = function(binding_id) {try {

        var $a, $b, TMP_4, self = this;

        if (self.binding_id['$=='](binding_id)) {
          return self};
        ($a = ($b = self.nodes).$each, $a._p = (TMP_4 = function(node){var self = TMP_4._s || this, $a, $b, val = nil;
if (node == null) node = nil;
        if ((($a = node['$is_a?']((($b = $scope.ComponentNode) == null ? $opal.cm('ComponentNode') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            val = node.$find_by_binding_id(binding_id);
            if (val !== false && val !== nil) {
              $opal.$return(val)
              } else {
              return nil
            };
            } else {
            return nil
          }}, TMP_4._s = self, TMP_4), $a).call($b);
        return nil;
        } catch ($returner) { if ($returner === $opal.returner) { return $returner.$v } throw $returner; }
      };

      def.$remove = function() {
        var self = this;

        self.nodes = [];
        return self['$changed!']();
      };

      def.$remove_anchors = function() {
        var self = this;

        self.$fail("not implemented");
        self.parent.$nodes().$delete(self);
        self['$changed!']();
        self.parent = nil;
        return self.binding_id = nil;
      };

      return (def.$inspect = function() {
        var self = this;

        return "<ComponentNode:" + (self.binding_id) + " " + (self.nodes.$inspect()) + ">";
      }, nil) && 'inspect';
    })(self, (($a = $scope.BaseNode) == null ? $opal.cm('BaseNode') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$new']);
  ;
  ;
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $AttributeTarget(){};
      var self = $AttributeTarget = $klass($base, $super, 'AttributeTarget', $AttributeTarget);

      var def = self._proto, $scope = self._scope;

      return (def.$dom_section = function(args) {
        var $a, $b, self = this;

        args = $slice.call(arguments, 0);
        return ($a = (($b = $scope.AttributeSection) == null ? $opal.cm('AttributeSection') : $b)).$new.apply($a, [self].concat(args));
      }, nil) && 'dom_section'
    })(self, (($a = $scope.ComponentNode) == null ? $opal.cm('ComponentNode') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$setup', '$watch!', '$lambda', '$update', '$instance_eval', '$to_proc', '$error', '$logger', '$inspect', '$is', '$element', '$attr', '$===', '$on', '$changed', '$value', '$instance_exec', '$find', '$+', '$binding_name', '$==', '$update_checked', '$stop', '$remove', '$is_a?', '$value=', '$html', '$nil?', '$!', '$[]=', '$prop', '$off', '$fail']);
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $AttributeBinding(){};
      var self = $AttributeBinding = $klass($base, $super, 'AttributeBinding', $AttributeBinding);

      var def = self._proto, $scope = self._scope, TMP_1;

      def.is_radio = def.attribute_name = def.setter = def.context = def.selected_value = def.string_template_renderer_computation = def.string_template_renderer = def.computation = nil;
      def.$initialize = TMP_1 = function(page, target, context, binding_name, attribute_name, getter, setter) {
        var self = this, $iter = TMP_1._p, $yield = $iter || nil;

        TMP_1._p = null;
        $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [page, target, context, binding_name]);
        self.attribute_name = attribute_name;
        self.getter = getter;
        self.setter = setter;
        return self.$setup();
      };

      def.$setup = function() {
        var $a, $b, TMP_2, $c, TMP_3, $d, TMP_4, self = this, $case = nil;

        self.computation = ($a = ($b = self).$lambda, $a._p = (TMP_2 = function(){var self = TMP_2._s || this, $a, $b, e = nil;
          if (self.getter == null) self.getter = nil;
          if (self.context == null) self.context = nil;

        try {
          return self.$update(($a = ($b = self.context).$instance_eval, $a._p = self.getter.$to_proc(), $a).call($b))
          } catch ($err) {if (true) {e = $err;
            (($a = $scope.Volt) == null ? $opal.cm('Volt') : $a).$logger().$error("AttributeBinding Error: " + (e.$inspect()));
            return self.$update("");
            }else { throw $err; }
          }}, TMP_2._s = self, TMP_2), $a).call($b)['$watch!']();
        self.is_radio = self.$element().$is("[type=radio]");
        if ((($a = self.is_radio) !== nil && (!$a._isBoolean || $a == true))) {
          self.selected_value = self.$element().$attr("value")};
        return (function() {$case = self.attribute_name;if ("value"['$===']($case)) {return ($a = ($c = self.$element()).$on, $a._p = (TMP_3 = function(){var self = TMP_3._s || this;

        return self.$changed()}, TMP_3._s = self, TMP_3), $a).call($c, "input.attrbind")}else if ("checked"['$===']($case)) {return ($a = ($d = self.$element()).$on, $a._p = (TMP_4 = function(event){var self = TMP_4._s || this;
if (event == null) event = nil;
        return self.$changed(event)}, TMP_4._s = self, TMP_4), $a).call($d, "change.attrbind")}else { return nil }})();
      };

      def.$changed = function(event) {
        var $a, $b, $c, self = this, $case = nil, current_value = nil;

        if (event == null) {
          event = nil
        }
        $case = self.attribute_name;if ("value"['$===']($case)) {current_value = self.$element().$value()}else {current_value = self.$element().$is(":checked")};
        if ((($a = self.is_radio) !== nil && (!$a._isBoolean || $a == true))) {
          if (current_value !== false && current_value !== nil) {
            return ($a = ($b = self.context).$instance_exec, $a._p = self.setter.$to_proc(), $a).call($b, self.selected_value)
            } else {
            return nil
          }
          } else {
          return ($a = ($c = self.context).$instance_exec, $a._p = self.setter.$to_proc(), $a).call($c, current_value)
        };
      };

      def.$element = function() {
        var $a, self = this;

        return (($a = $scope.Element) == null ? $opal.cm('Element') : $a).$find("#"['$+'](self.$binding_name()));
      };

      def.$update = function(new_value) {
        var $a, $b, TMP_5, $c, $d, self = this;

        if (self.attribute_name['$==']("checked")) {
          self.$update_checked(new_value);
          return nil;};
        if ((($a = self.string_template_renderer_computation) !== nil && (!$a._isBoolean || $a == true))) {
          self.string_template_renderer_computation.$stop()};
        if ((($a = self.string_template_renderer) !== nil && (!$a._isBoolean || $a == true))) {
          self.string_template_renderer.$remove()};
        if ((($a = new_value['$is_a?']((($b = $scope.StringTemplateRender) == null ? $opal.cm('StringTemplateRender') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
          self.string_template_renderer = new_value;
          return self.string_template_renderer_computation = ($a = ($b = self).$lambda, $a._p = (TMP_5 = function(){var self = TMP_5._s || this;
            if (self.string_template_renderer == null) self.string_template_renderer = nil;

          return self['$value='](self.string_template_renderer.$html())}, TMP_5._s = self, TMP_5), $a).call($b)['$watch!']();
          } else {
          if ((($a = ((($c = new_value['$is_a?']((($d = $scope.NilMethodCall) == null ? $opal.cm('NilMethodCall') : $d))) !== false && $c !== nil) ? $c : new_value['$nil?']())) !== nil && (!$a._isBoolean || $a == true))) {
            new_value = ""};
          return self['$value='](new_value);
        };
      };

      def['$value='] = function(val) {
        var $a, self = this, $case = nil;

        return (function() {$case = self.attribute_name;if ("value"['$===']($case)) {if ((($a = val['$=='](self.$element().$value())['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
          return self.$element()['$value='](val)
          } else {
          return nil
        }}else {return self.$element()['$[]='](self.attribute_name, val)}})();
      };

      def.$update_checked = function(value) {
        var $a, $b, $c, self = this;

        if ((($a = ((($b = value['$is_a?']((($c = $scope.NilMethodCall) == null ? $opal.cm('NilMethodCall') : $c))) !== false && $b !== nil) ? $b : value['$nil?']())) !== nil && (!$a._isBoolean || $a == true))) {
          value = false};
        if ((($a = self.is_radio) !== nil && (!$a._isBoolean || $a == true))) {
          value = (self.selected_value['$=='](value))};
        return self.$element().$prop("checked", value);
      };

      def.$remove = function() {
        var $a, self = this, $case = nil;

        $case = self.attribute_name;if ("value"['$===']($case)) {self.$element().$off("input.attrbind", nil)}else if ("checked"['$===']($case)) {self.$element().$off("change.attrbind", nil)};
        if ((($a = self.string_template_renderer) !== nil && (!$a._isBoolean || $a == true))) {
          self.string_template_renderer.$remove()};
        if ((($a = self.string_template_renderer_computation) !== nil && (!$a._isBoolean || $a == true))) {
          self.string_template_renderer_computation.$stop()};
        if ((($a = self.computation) !== nil && (!$a._isBoolean || $a == true))) {
          self.computation.$stop()};
        self.target = nil;
        self.context = nil;
        return self.getter = nil;
      };

      return (def.$remove_anchors = function() {
        var self = this;

        return self.$fail("attribute bindings do not have anchors, can not remove them");
      }, nil) && 'remove_anchors';
    })(self, (($a = $scope.BaseBinding) == null ? $opal.cm('BaseBinding') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$watch!', '$lambda', '$update', '$instance_eval', '$to_proc', '$error', '$logger', '$inspect', '$or', '$to_s', '$html=', '$dom_section', '$gsub', '$stop']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $ContentBinding(){};
      var self = $ContentBinding = $klass($base, $super, 'ContentBinding', $ContentBinding);

      var def = self._proto, $scope = self._scope, TMP_1, TMP_3;

      def.computation = nil;
      def.$initialize = TMP_1 = function(page, target, context, binding_name, getter) {
        var $a, $b, TMP_2, self = this, $iter = TMP_1._p, $yield = $iter || nil;

        TMP_1._p = null;
        $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [page, target, context, binding_name]);
        return self.computation = ($a = ($b = self).$lambda, $a._p = (TMP_2 = function(){var self = TMP_2._s || this, $a, $b, e = nil;
          if (self.context == null) self.context = nil;

        try {
          return self.$update(($a = ($b = self.context).$instance_eval, $a._p = getter.$to_proc(), $a).call($b))
          } catch ($err) {if (true) {e = $err;
            (($a = $scope.Volt) == null ? $opal.cm('Volt') : $a).$logger().$error("ContentBinding Error: " + (e.$inspect()));
            return self.$update("");
            }else { throw $err; }
          }}, TMP_2._s = self, TMP_2), $a).call($b)['$watch!']();
      };

      def.$update = function(value) {
        var self = this;

        value = value.$or("");
        value = value.$to_s();
        return self.$dom_section()['$html='](value.$gsub("\n", "<br />\n"));
      };

      return (def.$remove = TMP_3 = function() {var $zuper = $slice.call(arguments, 0);
        var $a, self = this, $iter = TMP_3._p, $yield = $iter || nil;

        TMP_3._p = null;
        if ((($a = self.computation) !== nil && (!$a._isBoolean || $a == true))) {
          self.computation.$stop()};
        self.computation = nil;
        return $opal.find_super_dispatcher(self, 'remove', TMP_3, $iter).apply(self, $zuper);
      }, nil) && 'remove';
    })(self, (($a = $scope.BaseBinding) == null ? $opal.cm('BaseBinding') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$watch!', '$lambda', '$reload', '$instance_eval', '$to_proc', '$error', '$logger', '$inspect', '$run_without_tracking', '$current_values', '$remove', '$respond_to?', '$on', '$item_added', '$item_removed', '$size', '$downto', '$-', '$upto', '$[]', '$locals', '$context', '$remove_anchors', '$delete_at', '$update_indexes_after', '$+', '$>=', '$insert_anchor_before_end', '$dom_section', '$insert_anchor_before', '$binding_name', '$new', '$[]=', '$to_sym', '$proc', '$changed!', '$depend', '$insert', '$>', '$call', '$is_a?', '$attributes', '$stop', '$times']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $EachBinding(){};
      var self = $EachBinding = $klass($base, $super, 'EachBinding', $EachBinding);

      var def = self._proto, $scope = self._scope, TMP_1, TMP_13;

      def.getter = def.context = def.templates = def.value = def.item_name = def.page = def.target = def.template_name = def.computation = def.added_listener = def.removed_listener = nil;
      def.$initialize = TMP_1 = function(page, target, context, binding_name, getter, variable_name, template_name) {
        var $a, $b, TMP_2, self = this, $iter = TMP_1._p, $yield = $iter || nil;

        TMP_1._p = null;
        $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [page, target, context, binding_name]);
        self.item_name = variable_name;
        self.template_name = template_name;
        self.templates = [];
        self.getter = getter;
        return self.computation = ($a = ($b = self).$lambda, $a._p = (TMP_2 = function(){var self = TMP_2._s || this;

        return self.$reload()}, TMP_2._s = self, TMP_2), $a).call($b)['$watch!']();
      };

      def.$reload = function() {
        var $a, $b, $c, TMP_3, $d, self = this, value = nil, e = nil;

        try {
        value = ($a = ($b = self.context).$instance_eval, $a._p = self.getter.$to_proc(), $a).call($b)
        } catch ($err) {if (true) {e = $err;
          (($a = $scope.Volt) == null ? $opal.cm('Volt') : $a).$logger().$error("EachBinding Error: " + (e.$inspect()));
          value = [];
          }else { throw $err; }
        };
        return ($a = ($c = (($d = $scope.Computation) == null ? $opal.cm('Computation') : $d)).$run_without_tracking, $a._p = (TMP_3 = function(){var self = TMP_3._s || this, $a, $b, TMP_4, $c, TMP_5, $d, TMP_6, $e, TMP_7, values = nil, templates_size = nil, values_size = nil;
          if (self.added_listener == null) self.added_listener = nil;
          if (self.removed_listener == null) self.removed_listener = nil;
          if (self.value == null) self.value = nil;
          if (self.templates == null) self.templates = nil;

        values = self.$current_values(value);
          self.value = values;
          if ((($a = self.added_listener) !== nil && (!$a._isBoolean || $a == true))) {
            self.added_listener.$remove()};
          if ((($a = self.removed_listener) !== nil && (!$a._isBoolean || $a == true))) {
            self.removed_listener.$remove()};
          if ((($a = self.value['$respond_to?']("on")) !== nil && (!$a._isBoolean || $a == true))) {
            self.added_listener = ($a = ($b = self.value).$on, $a._p = (TMP_4 = function(position){var self = TMP_4._s || this;
if (position == null) position = nil;
            return self.$item_added(position)}, TMP_4._s = self, TMP_4), $a).call($b, "added");
            self.removed_listener = ($a = ($c = self.value).$on, $a._p = (TMP_5 = function(position){var self = TMP_5._s || this;
if (position == null) position = nil;
            return self.$item_removed(position)}, TMP_5._s = self, TMP_5), $a).call($c, "removed");};
          templates_size = self.templates.$size();
          values_size = values.$size();
          ($a = ($d = (templates_size['$-'](1))).$downto, $a._p = (TMP_6 = function(index){var self = TMP_6._s || this;
if (index == null) index = nil;
          return self.$item_removed(index)}, TMP_6._s = self, TMP_6), $a).call($d, 0);
          return ($a = ($e = (0)).$upto, $a._p = (TMP_7 = function(index){var self = TMP_7._s || this;
if (index == null) index = nil;
          return self.$item_added(index)}, TMP_7._s = self, TMP_7), $a).call($e, values_size['$-'](1));}, TMP_3._s = self, TMP_3), $a).call($c);
      };

      def.$item_removed = function(position) {
        var self = this;

        self.templates['$[]'](position).$context().$locals()['$[]']("index_dependency").$remove();
        self.templates['$[]'](position).$remove_anchors();
        self.templates['$[]'](position).$remove();
        self.templates.$delete_at(position);
        return self.$update_indexes_after(position);
      };

      def.$item_added = function(position) {
        var $a, $b, TMP_8, $c, TMP_9, $d, TMP_10, self = this, binding_name = nil, item_context = nil, position_dependency = nil, item_template = nil;

        binding_name = (($a = $opal.cvars['@@binding_number']) == null ? nil : $a);
        ($opal.cvars['@@binding_number'] = (($a = $opal.cvars['@@binding_number']) == null ? nil : $a)['$+'](1));
        if (position['$>='](self.templates.$size())) {
          self.$dom_section().$insert_anchor_before_end(binding_name)
          } else {
          self.$dom_section().$insert_anchor_before(binding_name, self.templates['$[]'](position).$binding_name())
        };
        item_context = (($a = $scope.SubContext) == null ? $opal.cm('SubContext') : $a).$new($hash2(["_index_value", "parent"], {"_index_value": position, "parent": self.value}), self.context);
        item_context.$locals()['$[]='](self.item_name.$to_sym(), ($a = ($b = self).$proc, $a._p = (TMP_8 = function(){var self = TMP_8._s || this;
          if (self.value == null) self.value = nil;

        return self.value['$[]'](item_context.$locals()['$[]']("_index_value"))}, TMP_8._s = self, TMP_8), $a).call($b));
        position_dependency = (($a = $scope.Dependency) == null ? $opal.cm('Dependency') : $a).$new();
        item_context.$locals()['$[]=']("index_dependency", position_dependency);
        item_context.$locals()['$[]=']("index=", ($a = ($c = self).$proc, $a._p = (TMP_9 = function(val){var self = TMP_9._s || this;
if (val == null) val = nil;
        position_dependency['$changed!']();
          return item_context.$locals()['$[]=']("_index_value", val);}, TMP_9._s = self, TMP_9), $a).call($c));
        item_context.$locals()['$[]=']("index", ($a = ($d = self).$proc, $a._p = (TMP_10 = function(){var self = TMP_10._s || this;

        position_dependency.$depend();
          return item_context.$locals()['$[]']("_index_value");}, TMP_10._s = self, TMP_10), $a).call($d));
        item_template = (($a = $scope.TemplateRenderer) == null ? $opal.cm('TemplateRenderer') : $a).$new(self.page, self.target, item_context, binding_name, self.template_name);
        self.templates.$insert(position, item_template);
        return self.$update_indexes_after(position);
      };

      def.$update_indexes_after = function(start_index) {
        var $a, $b, TMP_11, self = this, size = nil;

        size = self.templates.$size();
        if (size['$>'](0)) {
          return ($a = ($b = start_index).$upto, $a._p = (TMP_11 = function(index){var self = TMP_11._s || this;
            if (self.templates == null) self.templates = nil;
if (index == null) index = nil;
          return self.templates['$[]'](index).$context().$locals()['$[]']("index=").$call(index)}, TMP_11._s = self, TMP_11), $a).call($b, size['$-'](1))
          } else {
          return nil
        };
      };

      def.$current_values = function(values) {
        var $a, $b, $c, self = this;

        if ((($a = ((($b = values['$is_a?']((($c = $scope.Model) == null ? $opal.cm('Model') : $c))) !== false && $b !== nil) ? $b : values['$is_a?']((($c = $scope.Exception) == null ? $opal.cm('Exception') : $c)))) !== nil && (!$a._isBoolean || $a == true))) {
          return []};
        if ((($a = values['$respond_to?']("attributes")) !== nil && (!$a._isBoolean || $a == true))) {
          values = values.$attributes()};
        return values;
      };

      return (def.$remove = TMP_13 = function() {var $zuper = $slice.call(arguments, 0);
        var $a, $b, TMP_12, self = this, $iter = TMP_13._p, $yield = $iter || nil, template_count = nil;

        TMP_13._p = null;
        self.computation.$stop();
        self.computation = nil;
        self.value = [];
        if ((($a = self.added_listener) !== nil && (!$a._isBoolean || $a == true))) {
          self.added_listener.$remove();
          self.added_listener = nil;};
        if ((($a = self.removed_listener) !== nil && (!$a._isBoolean || $a == true))) {
          self.removed_listener.$remove();
          self.removed_listener = nil;};
        if ((($a = self.templates) !== nil && (!$a._isBoolean || $a == true))) {
          template_count = self.templates.$size();
          ($a = ($b = template_count).$times, $a._p = (TMP_12 = function(index){var self = TMP_12._s || this;
if (index == null) index = nil;
          return self.$item_removed(template_count['$-'](index)['$-'](1))}, TMP_12._s = self, TMP_12), $a).call($b);
          self.templates = nil;};
        return $opal.find_super_dispatcher(self, 'remove', TMP_13, $iter).apply(self, $zuper);
      }, nil) && 'remove';
    })(self, (($a = $scope.BaseBinding) == null ? $opal.cm('BaseBinding') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$[]', '$each', '$present?', '$<<', '$watch!', '$lambda', '$update', '$is_a?', '$instance_eval', '$to_proc', '$error', '$logger', '$+', '$object_id', '$inspect', '$!', '$nil?', '$==', '$remove', '$new', '$binding_name', '$stop']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $IfBinding(){};
      var self = $IfBinding = $klass($base, $super, 'IfBinding', $IfBinding);

      var def = self._proto, $scope = self._scope, TMP_1, TMP_5;

      def.branches = def.last_true_template = def.template = def.page = def.target = def.context = def.computation = nil;
      def.$initialize = TMP_1 = function(page, target, context, binding_name, branches) {
        var $a, $b, TMP_2, $c, TMP_3, self = this, $iter = TMP_1._p, $yield = $iter || nil, getter = nil, template_name = nil;

        TMP_1._p = null;
        $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [page, target, context, binding_name]);
        $a = $opal.to_ary(branches['$[]'](0)), getter = ($a[0] == null ? nil : $a[0]), template_name = ($a[1] == null ? nil : $a[1]);
        self.branches = [];
        self.listeners = [];
        ($a = ($b = branches).$each, $a._p = (TMP_2 = function(branch){var self = TMP_2._s || this, $a, value = nil;
          if (self.branches == null) self.branches = nil;
if (branch == null) branch = nil;
        $a = $opal.to_ary(branch), getter = ($a[0] == null ? nil : $a[0]), template_name = ($a[1] == null ? nil : $a[1]);
          if ((($a = getter['$present?']()) !== nil && (!$a._isBoolean || $a == true))) {
            value = getter
            } else {
            value = true
          };
          return self.branches['$<<']([value, template_name]);}, TMP_2._s = self, TMP_2), $a).call($b);
        return self.computation = ($a = ($c = self).$lambda, $a._p = (TMP_3 = function(){var self = TMP_3._s || this;

        return self.$update()}, TMP_3._s = self, TMP_3), $a).call($c)['$watch!']();
      };

      def.$update = function() {
        var $a, $b, TMP_4, self = this, true_template = nil;

        true_template = nil;
        ($a = ($b = self.branches).$each, $a._p = (TMP_4 = function(branch){var self = TMP_4._s || this, $a, $b, $c, $d, value = nil, template_name = nil, current_value = nil, e = nil;
          if (self.context == null) self.context = nil;
if (branch == null) branch = nil;
        $a = $opal.to_ary(branch), value = ($a[0] == null ? nil : $a[0]), template_name = ($a[1] == null ? nil : $a[1]);
          if ((($a = value['$is_a?']((($b = $scope.Proc) == null ? $opal.cm('Proc') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            try {
            current_value = ($a = ($b = self.context).$instance_eval, $a._p = value.$to_proc(), $a).call($b)
            } catch ($err) {if (true) {e = $err;
              (($a = $scope.Volt) == null ? $opal.cm('Volt') : $a).$logger().$error(((((("IfBinding:") + (self.$object_id())) + " error: ") + (e.$inspect())) + "\n")['$+'](value.toString()));
              current_value = false;
              }else { throw $err; }
            }
            } else {
            current_value = value
          };
          if ((($a = ($c = (($d = current_value !== false && current_value !== nil) ? current_value['$nil?']()['$!']() : $d), $c !== false && $c !== nil ?current_value['$is_a?']((($d = $scope.Exception) == null ? $opal.cm('Exception') : $d))['$!']() : $c)) !== nil && (!$a._isBoolean || $a == true))) {
            true_template = template_name;
            return ($breaker.$v = nil, $breaker);
            } else {
            return nil
          };}, TMP_4._s = self, TMP_4), $a).call($b);
        if ((($a = self.last_true_template['$=='](true_template)['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
          self.last_true_template = true_template;
          if ((($a = self.template) !== nil && (!$a._isBoolean || $a == true))) {
            self.template.$remove();
            self.template = nil;};
          if (true_template !== false && true_template !== nil) {
            return self.template = (($a = $scope.TemplateRenderer) == null ? $opal.cm('TemplateRenderer') : $a).$new(self.page, self.target, self.context, self.$binding_name(), true_template)
            } else {
            return nil
          };
          } else {
          return nil
        };
      };

      return (def.$remove = TMP_5 = function() {var $zuper = $slice.call(arguments, 0);
        var $a, self = this, $iter = TMP_5._p, $yield = $iter || nil;

        TMP_5._p = null;
        if ((($a = self.computation) !== nil && (!$a._isBoolean || $a == true))) {
          self.computation.$stop()};
        self.computation = nil;
        if ((($a = self.template) !== nil && (!$a._isBoolean || $a == true))) {
          self.template.$remove()};
        return $opal.find_super_dispatcher(self, 'remove', TMP_5, $iter).apply(self, $zuper);
      }, nil) && 'remove';
    })(self, (($a = $scope.BaseBinding) == null ? $opal.cm('BaseBinding') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$attr_reader', '$set_content_to_template', '$dom_section', '$each_pair', '$each', '$<<', '$call', '$to_proc']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $TemplateRenderer(){};
      var self = $TemplateRenderer = $klass($base, $super, 'TemplateRenderer', $TemplateRenderer);

      var def = self._proto, $scope = self._scope, TMP_1, TMP_4;

      def.sub_bindings = nil;
      self.$attr_reader("context");

      def.$initialize = TMP_1 = function(page, target, context, binding_name, template_name) {
        var $a, $b, TMP_2, self = this, $iter = TMP_1._p, $yield = $iter || nil, bindings = nil;

        TMP_1._p = null;
        $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [page, target, context, binding_name]);
        self.sub_bindings = [];
        bindings = self.$dom_section().$set_content_to_template(page, template_name);
        return ($a = ($b = bindings).$each_pair, $a._p = (TMP_2 = function(id, bindings_for_id){var self = TMP_2._s || this, $a, $b, TMP_3;
if (id == null) id = nil;if (bindings_for_id == null) bindings_for_id = nil;
        return ($a = ($b = bindings_for_id).$each, $a._p = (TMP_3 = function(binding){var self = TMP_3._s || this;
            if (self.sub_bindings == null) self.sub_bindings = nil;
if (binding == null) binding = nil;
          return self.sub_bindings['$<<'](binding.$call(page, target, context, id))}, TMP_3._s = self, TMP_3), $a).call($b)}, TMP_2._s = self, TMP_2), $a).call($b);
      };

      return (def.$remove = TMP_4 = function() {var $zuper = $slice.call(arguments, 0);
        var $a, $b, self = this, $iter = TMP_4._p, $yield = $iter || nil;

        TMP_4._p = null;
        ($a = ($b = self.sub_bindings).$each, $a._p = "remove".$to_proc(), $a).call($b);
        self.sub_bindings = [];
        return $opal.find_super_dispatcher(self, 'remove', TMP_4, $iter).apply(self, $zuper);
      }, nil) && 'remove';
    })(self, (($a = $scope.BaseBinding) == null ? $opal.cm('BaseBinding') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$controller', '$[]', '$[]=', '$+', '$-', '$==', '$delete', '$private']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $GroupedControllers(){};
      var self = $GroupedControllers = $klass($base, $super, 'GroupedControllers', $GroupedControllers);

      var def = self._proto, $scope = self._scope;

      def.name = nil;
      ($opal.cvars['@@controllers'] = $hash2([], {}));

      def.$initialize = function(name) {
        var self = this;

        return self.name = name;
      };

      def.$get = function() {
        var $a, self = this, controller = nil;

        return ($a = (controller = self.$controller()), $a !== false && $a !== nil ?controller['$[]'](0) : $a);
      };

      def.$set = function(controller) {
        var $a, self = this;

        return (($a = $opal.cvars['@@controllers']) == null ? nil : $a)['$[]='](self.name, [controller, 1]);
      };

      def.$inc = function() {
        var $a, $b, self = this;

        return ($a = 1, $b = self.$controller(), $b['$[]=']($a, $b['$[]']($a)['$+'](1)));
      };

      def.$clear = function() {
        var $a, $b, self = this, controller = nil;

        controller = self.$controller();
        ($a = 1, $b = controller, $b['$[]=']($a, $b['$[]']($a)['$-'](1)));
        if (controller['$[]'](1)['$=='](0)) {
          return (($a = $opal.cvars['@@controllers']) == null ? nil : $a).$delete(self.name)
          } else {
          return nil
        };
      };

      self.$private();

      return (def.$controller = function() {
        var $a, self = this;

        return (($a = $opal.cvars['@@controllers']) == null ? nil : $a)['$[]'](self.name);
      }, nil) && 'controller';
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2, $range = $opal.range;

  $opal.add_stubs(['$setup_path', '$watch!', '$lambda', '$update', '$instance_eval', '$to_proc', '$split', '$[]', '$templates', '$size', '$[]=', '$times', '$==', '$-', '$>=', '$join', '$check_for_template?', '$+', '$run_without_tracking', '$controller_send', '$to_s', '$remove', '$blank?', '$is_a?', '$new', '$clear_grouped_controller', '$path_for_template', '$render_template', '$queue_clear_grouped_controller', '$in_browser?', '$clear', '$get', '$inc', '$get_controller', '$set', '$call_ready', '$respond_to?', '$section=', '$dom_section', '$private', '$send', '$>', '$map', '$camelize', '$tr', '$first', '$shift', '$each', '$const_defined?', '$const_get']);
  ;
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $TemplateBinding(){};
      var self = $TemplateBinding = $klass($base, $super, 'TemplateBinding', $TemplateBinding);

      var def = self._proto, $scope = self._scope, TMP_1, TMP_6;

      def.page = def.grouped_controller = def["arguments"] = def.controller = def.action = def.target = def.binding_name = def.current_template = nil;
      def.$initialize = TMP_1 = function(page, target, context, binding_name, binding_in_path, getter) {
        var $a, $b, TMP_2, self = this, $iter = TMP_1._p, $yield = $iter || nil;

        TMP_1._p = null;
        $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [page, target, context, binding_name]);
        self.$setup_path(binding_in_path);
        self.current_template = nil;
        return self.computation = ($a = ($b = self).$lambda, $a._p = (TMP_2 = function(){var self = TMP_2._s || this, $a, $b, $c;
          if (self.context == null) self.context = nil;

        if ((($a = self.context) !== nil && (!$a._isBoolean || $a == true))) {
            return ($a = self).$update.apply($a, [].concat(($b = ($c = self.context).$instance_eval, $b._p = getter.$to_proc(), $b).call($c)))
            } else {
            return nil
          }}, TMP_2._s = self, TMP_2), $a).call($b)['$watch!']();
      };

      def.$setup_path = function(binding_in_path) {
        var self = this, path_parts = nil;

        path_parts = binding_in_path.$split("/");
        self.collection_name = path_parts['$[]'](0);
        self.controller_name = path_parts['$[]'](1);
        return self.page_name = path_parts['$[]'](2);
      };

      def['$check_for_template?'] = function(path) {
        var self = this;

        return self.page.$templates()['$[]'](path);
      };

      def.$path_for_template = function(lookup_path, force_section) {try {

        var $a, $b, TMP_3, self = this, parts = nil, parts_size = nil, default_parts = nil;

        if (force_section == null) {
          force_section = nil
        }
        parts = lookup_path.$split("/");
        parts_size = parts.$size();
        default_parts = ["main", "main", "index", "body"];
        if (force_section !== false && force_section !== nil) {
          default_parts['$[]='](-1, force_section)};
        ($a = ($b = ((5)['$-'](parts_size))).$times, $a._p = (TMP_3 = function(path_position){var self = TMP_3._s || this, $a, $b, TMP_4, full_path = nil, start_at = nil, path = nil, controller = nil, init_method = nil;
          if (self.collection_name == null) self.collection_name = nil;
          if (self.controller_name == null) self.controller_name = nil;
          if (self.page_name == null) self.page_name = nil;
if (path_position == null) path_position = nil;
        if ((($a = (($b = force_section !== false && force_section !== nil) ? path_position['$=='](0) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            return nil;};
          full_path = [self.collection_name, self.controller_name, self.page_name, nil];
          start_at = full_path.$size()['$-'](parts_size)['$-'](path_position);
          ($a = ($b = full_path.$size()).$times, $a._p = (TMP_4 = function(index){var self = TMP_4._s || this, $a, part = nil;
if (index == null) index = nil;
          if (index['$>='](start_at)) {
              if ((($a = (part = parts['$[]'](index['$-'](start_at)))) !== nil && (!$a._isBoolean || $a == true))) {
                return full_path['$[]='](index, part)
                } else {
                return full_path['$[]='](index, default_parts['$[]'](index))
              }
              } else {
              return nil
            }}, TMP_4._s = self, TMP_4), $a).call($b);
          path = full_path.$join("/");
          if ((($a = self['$check_for_template?'](path)) !== nil && (!$a._isBoolean || $a == true))) {
            controller = nil;
            if (path_position['$>='](1)) {
              init_method = full_path['$[]'](2)
              } else {
              init_method = full_path['$[]'](3)
            };
            controller = [full_path['$[]'](0), full_path['$[]'](1)['$+']("_controller"), init_method];
            $opal.$return([path, controller]);
            } else {
            return nil
          };}, TMP_3._s = self, TMP_3), $a).call($b);
        return [nil, nil];
        } catch ($returner) { if ($returner === $opal.returner) { return $returner.$v } throw $returner; }
      };

      def.$update = function(path, section_or_arguments, options) {
        var $a, $b, TMP_5, $c, self = this;

        if (section_or_arguments == null) {
          section_or_arguments = nil
        }
        if (options == null) {
          options = $hash2([], {})
        }
        return ($a = ($b = (($c = $scope.Computation) == null ? $opal.cm('Computation') : $c)).$run_without_tracking, $a._p = (TMP_5 = function(){var self = TMP_5._s || this, $a, $b, section = nil, controller_group = nil, full_path = nil, controller_path = nil;
          if (self.action == null) self.action = nil;
          if (self.controller == null) self.controller = nil;
          if (self.current_template == null) self.current_template = nil;
          if (self.options == null) self.options = nil;

        if ((($a = ($b = self.action, $b !== false && $b !== nil ?self.controller : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            self.$controller_send(("" + self.action.$to_s() + "_removed"))};
          if ((($a = self.current_template) !== nil && (!$a._isBoolean || $a == true))) {
            self.current_template.$remove();
            self.current_template = nil;};
          self.options = options;
          path = (function() {if ((($a = path['$blank?']()) !== nil && (!$a._isBoolean || $a == true))) {
            return "---missing---"
            } else {
            return path
          }; return nil; })();
          section = nil;
          self["arguments"] = nil;
          if ((($a = section_or_arguments['$is_a?']((($b = $scope.String) == null ? $opal.cm('String') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            section = section_or_arguments
            } else {
            self["arguments"] = section_or_arguments
          };
          if ((($a = ($b = self.options, $b !== false && $b !== nil ?(controller_group = self.options['$[]']("controller_group")) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            self.grouped_controller = (($a = $scope.GroupedControllers) == null ? $opal.cm('GroupedControllers') : $a).$new(controller_group)
            } else {
            self.$clear_grouped_controller()
          };
          $a = $opal.to_ary(self.$path_for_template(path, section)), full_path = ($a[0] == null ? nil : $a[0]), controller_path = ($a[1] == null ? nil : $a[1]);
          self.$render_template(full_path, controller_path);
          return self.$queue_clear_grouped_controller();}, TMP_5._s = self, TMP_5), $a).call($b);
      };

      def.$queue_clear_grouped_controller = function() {
        var $a, $b, self = this;

        if ((($a = (($b = $scope.Volt) == null ? $opal.cm('Volt') : $b)['$in_browser?']()) !== nil && (!$a._isBoolean || $a == true))) {
          setImmediate(function() {;
          self.$clear_grouped_controller();
          });
          } else {
          return self.$clear_grouped_controller()
        };
      };

      def.$clear_grouped_controller = function() {
        var $a, self = this;

        if ((($a = self.grouped_controller) !== nil && (!$a._isBoolean || $a == true))) {
          self.grouped_controller.$clear();
          return self.grouped_controller = nil;
          } else {
          return nil
        };
      };

      def.$render_template = function(full_path, controller_path) {
        var $a, $b, $c, self = this, args = nil, controller_class = nil;

        args = [(($a = $scope.SubContext) == null ? $opal.cm('SubContext') : $a).$new(self["arguments"], nil, true)];
        self.controller = nil;
        if ((($a = self.grouped_controller) !== nil && (!$a._isBoolean || $a == true))) {
          self.controller = self.grouped_controller.$get()};
        self.action = nil;
        if ((($a = self.controller) !== nil && (!$a._isBoolean || $a == true))) {
          if ((($a = self.grouped_controller) !== nil && (!$a._isBoolean || $a == true))) {
            self.grouped_controller.$inc()}
          } else {
          $a = $opal.to_ary(self.$get_controller(controller_path)), controller_class = ($a[0] == null ? nil : $a[0]), self.action = ($a[1] == null ? nil : $a[1]);
          if (controller_class !== false && controller_class !== nil) {
            self.controller = ($a = controller_class).$new.apply($a, [].concat(args))
            } else {
            self.controller = ($b = (($c = $scope.ModelController) == null ? $opal.cm('ModelController') : $c)).$new.apply($b, [].concat(args))
          };
          if ((($c = self.action) !== nil && (!$c._isBoolean || $c == true))) {
            self.$controller_send(self.action)};
          if ((($c = self.grouped_controller) !== nil && (!$c._isBoolean || $c == true))) {
            self.grouped_controller.$set(self.controller)};
        };
        self.current_template = (($c = $scope.TemplateRenderer) == null ? $opal.cm('TemplateRenderer') : $c).$new(self.page, self.target, self.controller, self.binding_name, full_path);
        return self.$call_ready();
      };

      def.$call_ready = function() {
        var $a, self = this;

        if ((($a = self.controller) !== nil && (!$a._isBoolean || $a == true))) {
          if ((($a = self.controller['$respond_to?']("section=")) !== nil && (!$a._isBoolean || $a == true))) {
            self.controller['$section='](self.current_template.$dom_section())};
          if ((($a = self.action) !== nil && (!$a._isBoolean || $a == true))) {
            return self.$controller_send(("" + self.action.$to_s() + "_ready"))
            } else {
            return nil
          };
          } else {
          return nil
        };
      };

      def.$remove = TMP_6 = function() {var $zuper = $slice.call(arguments, 0);
        var $a, self = this, $iter = TMP_6._p, $yield = $iter || nil;

        TMP_6._p = null;
        self.$clear_grouped_controller();
        if ((($a = self.current_template) !== nil && (!$a._isBoolean || $a == true))) {
          self.current_template.$remove()};
        $opal.find_super_dispatcher(self, 'remove', TMP_6, $iter).apply(self, $zuper);
        if ((($a = self.controller) !== nil && (!$a._isBoolean || $a == true))) {
          if ((($a = self.action) !== nil && (!$a._isBoolean || $a == true))) {
            self.$controller_send(("" + self.action.$to_s() + "_removed"))};
          return self.controller = nil;
          } else {
          return nil
        };
      };

      self.$private();

      def.$controller_send = function(action_name) {
        var $a, self = this;

        if ((($a = self.controller['$respond_to?'](action_name)) !== nil && (!$a._isBoolean || $a == true))) {
          return self.controller.$send(action_name)
          } else {
          return nil
        };
      };

      return (def.$get_controller = function(controller_path) {try {

        var $a, $b, TMP_7, $c, TMP_8, self = this, action = nil, parts = nil, obj = nil;

        if ((($a = (($b = controller_path !== false && controller_path !== nil) ? controller_path.$size()['$>'](0) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          return [nil, nil]
        };
        action = controller_path['$[]'](-1);
        parts = ($a = ($b = controller_path['$[]']($range(0, -2, false))).$map, $a._p = (TMP_7 = function(v){var self = TMP_7._s || this;
if (v == null) v = nil;
        return v.$tr("-", "_").$camelize()}, TMP_7._s = self, TMP_7), $a).call($b);
        if (parts.$first()['$==']("Main")) {
          parts.$shift()};
        obj = (($a = $scope.Object) == null ? $opal.cm('Object') : $a);
        ($a = ($c = parts).$each, $a._p = (TMP_8 = function(part){var self = TMP_8._s || this, $a;
if (part == null) part = nil;
        if ((($a = obj['$const_defined?'](part)) !== nil && (!$a._isBoolean || $a == true))) {
            return obj = obj.$const_get(part)
            } else {
            $opal.$return(nil)
          }}, TMP_8._s = self, TMP_8), $a).call($c);
        return [obj, action];
        } catch ($returner) { if ($returner === $opal.returner) { return $returner.$v } throw $returner; }
      }, nil) && 'get_controller';
    })(self, (($a = $scope.BaseBinding) == null ? $opal.cm('BaseBinding') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs([]);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $ComponentBinding(){};
      var self = $ComponentBinding = $klass($base, $super, 'ComponentBinding', $ComponentBinding);

      var def = self._proto, $scope = self._scope;

      return nil;
    })(self, (($a = $scope.TemplateBinding) == null ? $opal.cm('TemplateBinding') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$attr_reader', '$attr_accessor', '$proc', '$new', '$==', '$prevent_default!', '$instance_exec', '$to_proc', '$add', '$events', '$remove']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $JSEvent(){};
      var self = $JSEvent = $klass($base, $super, 'JSEvent', $JSEvent);

      var def = self._proto, $scope = self._scope;

      self.$attr_reader("js_event");

      def.$initialize = function(js_event) {
        var self = this;

        return self.js_event = js_event;
      };

      def.$key_code = function() {
        var self = this;

        return this.js_event.keyCode;
      };

      def['$stop!'] = function() {
        var self = this;

        this.js_event.stopPropagation();
      };

      def['$prevent_default!'] = function() {
        var self = this;

        this.js_event.preventDefault();
      };

      return (def.$target = function() {
        var self = this;

        return this.js_event.toElement;
      }, nil) && 'target';
    })(self, null);

    (function($base, $super) {
      function $EventBinding(){};
      var self = $EventBinding = $klass($base, $super, 'EventBinding', $EventBinding);

      var def = self._proto, $scope = self._scope, TMP_1;

      def.page = def.event_name = nil;
      self.$attr_accessor("context", "binding_name");

      def.$initialize = TMP_1 = function(page, target, context, binding_name, event_name, call_proc) {
        var $a, $b, TMP_2, self = this, $iter = TMP_1._p, $yield = $iter || nil, handler = nil;

        TMP_1._p = null;
        $opal.find_super_dispatcher(self, 'initialize', TMP_1, null).apply(self, [page, target, context, binding_name]);
        self.event_name = event_name;
        handler = ($a = ($b = self).$proc, $a._p = (TMP_2 = function(js_event){var self = TMP_2._s || this, $a, $b, event = nil, result = nil;
          if (self.context == null) self.context = nil;
if (js_event == null) js_event = nil;
        event = (($a = $scope.JSEvent) == null ? $opal.cm('JSEvent') : $a).$new(js_event);
          if (event_name['$==']("submit")) {
            event['$prevent_default!']()};
          return result = ($a = ($b = self.context).$instance_exec, $a._p = call_proc.$to_proc(), $a).call($b, event);}, TMP_2._s = self, TMP_2), $a).call($b);
        return self.listener = self.page.$events().$add(event_name, self, handler);
      };

      return (def.$remove = function() {
        var self = this;

        return self.page.$events().$remove(self.event_name, self);
      }, nil) && 'remove';
    })(self, (($a = $scope.BaseBinding) == null ? $opal.cm('BaseBinding') : $a));
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$new', '$depend', '$run_without_tracking', '$to_html', '$changed!', '$remove']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $StringTemplateRender(){};
      var self = $StringTemplateRender = $klass($base, $super, 'StringTemplateRender', $StringTemplateRender);

      var def = self._proto, $scope = self._scope;

      def.target = def.dependency = nil;
      def.$initialize = function(page, context, template_path) {
        var $a, self = this;

        self.dependency = (($a = $scope.Dependency) == null ? $opal.cm('Dependency') : $a).$new();
        self.template_path = template_path;
        self.target = (($a = $scope.AttributeTarget) == null ? $opal.cm('AttributeTarget') : $a).$new(nil, nil, self);
        return self.template = (($a = $scope.TemplateRenderer) == null ? $opal.cm('TemplateRenderer') : $a).$new(page, self.target, context, "main", template_path);
      };

      def.$html = function() {
        var $a, $b, TMP_1, $c, self = this, html = nil;

        self.dependency.$depend();
        html = nil;
        ($a = ($b = (($c = $scope.Computation) == null ? $opal.cm('Computation') : $c)).$run_without_tracking, $a._p = (TMP_1 = function(){var self = TMP_1._s || this;
          if (self.target == null) self.target = nil;

        return html = self.target.$to_html()}, TMP_1._s = self, TMP_1), $a).call($b);
        return html;
      };

      def['$changed!'] = function() {
        var $a, self = this;

        if ((($a = self.dependency) !== nil && (!$a._isBoolean || $a == true))) {
          return self.dependency['$changed!']()
          } else {
          return nil
        };
      };

      return (def.$remove = function() {
        var $a, $b, TMP_2, $c, self = this;

        self.dependency.$remove();
        self.dependency = nil;
        ($a = ($b = (($c = $scope.Computation) == null ? $opal.cm('Computation') : $c)).$run_without_tracking, $a._p = (TMP_2 = function(){var self = TMP_2._s || this;
          if (self.template == null) self.template = nil;

        self.template.$remove();
          return self.template = nil;}, TMP_2._s = self, TMP_2), $a).call($b);
        self.target = nil;
        return self.template_path = nil;
      }, nil) && 'remove';
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2;

  $opal.add_stubs(['$[]', '$[]=', '$binding_name', '$object_id', '$find', '$loop', '$id', '$each', '$call', '$values', '$==', '$size', '$parent', '$delete']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $DocumentEvents(){};
      var self = $DocumentEvents = $klass($base, $super, 'DocumentEvents', $DocumentEvents);

      var def = self._proto, $scope = self._scope;

      def.events = nil;
      def.$initialize = function() {
        var self = this;

        return self.events = $hash2([], {});
      };

      def.$add = function(event, binding, handler) {
        var $a, $b, $c, self = this, that = nil;

        if ((($a = self.events['$[]'](event)) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          self.events['$[]='](event, $hash2([], {}));
          that = self;
          
        $('body').on(event, function(e) {
          that.$handle(event, e, e.target || e.originalEvent.target);
        });
      
        };
        ($a = binding.$binding_name(), $b = self.events['$[]'](event), ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, $hash2([], {}))));
        return self.events['$[]'](event)['$[]'](binding.$binding_name())['$[]='](binding.$object_id(), handler);
      };

      def.$handle = function(event_name, event, target) {
        var $a, $b, TMP_1, self = this, element = nil;

        element = (($a = $scope.Element) == null ? $opal.cm('Element') : $a).$find(target);
        ($a = ($b = self).$loop, $a._p = (TMP_1 = function(){var self = TMP_1._s || this, $a, $b, TMP_2, handlers = nil;
          if (self.events == null) self.events = nil;

        handlers = self.events['$[]'](event_name);
          if (handlers !== false && handlers !== nil) {
            handlers = handlers['$[]'](element.$id())};
          if (handlers !== false && handlers !== nil) {
            ($a = ($b = handlers.$values()).$each, $a._p = (TMP_2 = function(handler){var self = TMP_2._s || this;
if (handler == null) handler = nil;
            return handler.$call(event)}, TMP_2._s = self, TMP_2), $a).call($b)};
          if (element.$size()['$=='](0)) {
            return ($breaker.$v = nil, $breaker)
            } else {
            return element = element.$parent()
          };}, TMP_1._s = self, TMP_1), $a).call($b);
        return nil;
      };

      return (def.$remove = function(event, binding) {
        var self = this;

        self.events['$[]'](event)['$[]'](binding.$binding_name()).$delete(binding.$object_id());
        if (self.events['$[]'](event)['$[]'](binding.$binding_name()).$size()['$=='](0)) {
          self.events['$[]'](event).$delete(binding.$binding_name())};
        if (self.events['$[]'](event).$size()['$=='](0)) {
          self.events.$delete(event);
          
          $('body').unbind(event);
        
          } else {
          return nil
        };
      }, nil) && 'remove';
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$attr_reader', '$stringify_keys', '$!', '$[]', '$to_s', '$respond_to?', '$inspect', '$key?', '$is_a?', '$call', '$==', '$send', '$to_proc', '$fail', '$new', '$class']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $SubContext(){};
      var self = $SubContext = $klass($base, $super, 'SubContext', $SubContext);

      var def = self._proto, $scope = self._scope, TMP_1;

      def.locals = def.context = def.return_nils = nil;
      self.$attr_reader("locals");

      def.$initialize = function(locals, context, return_nils) {
        var self = this;

        if (locals == null) {
          locals = nil
        }
        if (context == null) {
          context = nil
        }
        if (return_nils == null) {
          return_nils = false
        }
        if (locals !== false && locals !== nil) {
          self.locals = locals.$stringify_keys()};
        self.context = context;
        return self.return_nils = return_nils;
      };

      def['$respond_to?'] = function(method_name) {
        var $a, $b, self = this;

        return (((($a = (($b = self.locals, $b !== false && $b !== nil ?self.locals['$[]'](method_name.$to_s()) : $b))) !== false && $a !== nil) ? $a : (($b = self.context, $b !== false && $b !== nil ?self.context['$respond_to?'](method_name) : $b))))['$!']()['$!']();
      };

      def.$inspect = function() {
        var self = this;

        return "#<SubContext " + (self.locals.$inspect()) + " context:" + (self.context.$inspect()) + ">";
      };

      return (def.$method_missing = TMP_1 = function(method_name, args) {
        var $a, $b, $c, self = this, $iter = TMP_1._p, block = $iter || nil, obj = nil;

        args = $slice.call(arguments, 1);
        TMP_1._p = null;
        method_name = method_name.$to_s();
        if ((($a = ($b = self.locals, $b !== false && $b !== nil ?self.locals['$key?'](method_name) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          obj = self.locals['$[]'](method_name);
          if ((($a = obj['$is_a?']((($b = $scope.Proc) == null ? $opal.cm('Proc') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            obj = ($a = obj).$call.apply($a, [].concat(args))};
          return obj;
        } else if ((($b = ($c = self.return_nils, $c !== false && $c !== nil ?method_name['$[]'](-1)['$==']("=")['$!']() : $c)) !== nil && (!$b._isBoolean || $b == true))) {
          return nil
        } else if ((($b = self.context) !== nil && (!$b._isBoolean || $b == true))) {
          return ($b = ($c = self.context).$send, $b._p = block.$to_proc(), $b).apply($c, [method_name].concat(args))};
        return self.$fail((($b = $scope.NoMethodError) == null ? $opal.cm('NoMethodError') : $b).$new("undefined method `" + (method_name) + "' for \"" + (self.$inspect()) + "\":" + (self.$class())));
      }, nil) && 'method_missing';
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$find_by_comment', '$build_from_html', '$nodes=', '$range', '$before', '$find', '$make_new', '$class']);
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $DomSection(){};
      var self = $DomSection = $klass($base, $super, 'DomSection', $DomSection);

      var def = self._proto, $scope = self._scope, $a;

      def.end_node = def.range = nil;
      self.$include((($a = $scope.CommentSearchers) == null ? $opal.cm('CommentSearchers') : $a));

      def.$initialize = function(binding_name) {
        var self = this;

        self.start_node = self.$find_by_comment("$" + (binding_name));
        return self.end_node = self.$find_by_comment("$/" + (binding_name));
      };

      def['$text='] = function(value) {
        var self = this;

        
        this.$range().deleteContents();
        this.$range().insertNode(document.createTextNode(value));
      
      };

      def['$html='] = function(value) {
        var self = this, new_nodes = nil;

        new_nodes = self.$build_from_html(value);
        return self['$nodes='](new_nodes.childNodes);
      };

      def.$remove = function() {
        var self = this, range = nil;

        range = self.$range();
        
        range.deleteContents();
      
      };

      def.$remove_anchors = function() {
        var self = this;

        
        this.start_node.parentNode.removeChild(this.start_node);
        this.end_node.parentNode.removeChild(this.end_node);
      
        self.start_node = nil;
        return self.end_node = nil;
      };

      def.$insert_anchor_before_end = function(binding_name) {
        var $a, self = this;

        return (($a = $scope.Element) == null ? $opal.cm('Element') : $a).$find(self.end_node).$before("<!-- $" + (binding_name) + " --><!-- $/" + (binding_name) + " -->");
      };

      def.$insert_anchor_before = function(binding_name, insert_after_binding) {
        var $a, self = this, node = nil;

        node = self.$find_by_comment("$" + (insert_after_binding));
        return (($a = $scope.Element) == null ? $opal.cm('Element') : $a).$find(node).$before("<!-- $" + (binding_name) + " --><!-- $/" + (binding_name) + " -->");
      };

      def['$nodes='] = function(nodes) {
        var self = this, range = nil;

        range = self.$range();
        
        range.deleteContents();

        for (var i=nodes.length-1; i >= 0; i--) {
          var node = nodes[i];

          node.parentNode.removeChild(node);
          range.insertNode(node);
        }
      
      };

      def.$container_node = function() {
        var self = this, range = nil;

        range = self.$range();
        return range.commonAncestorContainer;
      };

      def.$set_template = function(dom_template) {
        var $a, self = this, dom_nodes = nil, bindings = nil, children = nil;

        $a = $opal.to_ary(dom_template.$make_new()), dom_nodes = ($a[0] == null ? nil : $a[0]), bindings = ($a[1] == null ? nil : $a[1]);
        children = nil;
        
      children = dom_nodes.childNodes;
        
        self['$nodes='](children);
        
      dom_nodes = null;
        
        return bindings;
      };

      def.$range = function() {
        var $a, self = this, range = nil;

        if ((($a = self.range) !== nil && (!$a._isBoolean || $a == true))) {
          return self.range};
        range = nil;
        
        range = document.createRange();
        range.setStartAfter(this.start_node);
        range.setEndBefore(this.end_node);
      
        self.range = range;
        return range;
      };

      return (def.$inspect = function() {
        var self = this;

        return "<" + (self.$class()) + ">";
      }, nil) && 'inspect';
    })(self, (($a = $scope.BaseSection) == null ? $opal.cm('BaseSection') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$new']);
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    (function($base, $super) {
      function $DomTarget(){};
      var self = $DomTarget = $klass($base, $super, 'DomTarget', $DomTarget);

      var def = self._proto, $scope = self._scope;

      return (def.$dom_section = function(args) {
        var $a, $b, self = this;

        args = $slice.call(arguments, 0);
        return ($a = (($b = $scope.DomSection) == null ? $opal.cm('DomSection') : $b)).$new.apply($a, [].concat(args));
      }, nil) && 'dom_section'
    })(self, (($a = $scope.BaseSection) == null ? $opal.cm('BaseSection') : $a))
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$include', '$reactive_accessor', '$status=', '$connected=', '$error=', '$retry_count=', '$connect!', '$connected', '$reconnect_interval=', '$each', '$send_message', '$reconnect!', '$reconnect_interval', '$+', '$rand', '$retry_count', '$reconnect_in=', '$reconnect_tick', '$parse', '$trigger!', '$!', '$==', '$status', '$<<', '$dump', '$private', '$>=', '$reconnect_in', '$-']);
  ;
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $Channel(){};
      var self = $Channel = $klass($base, $super, 'Channel', $Channel);

      var def = self._proto, $scope = self._scope, $a;

      def.queue = nil;
      self.$include((($a = $scope.ReactiveAccessors) == null ? $opal.cm('ReactiveAccessors') : $a));

      self.$include((($a = $scope.Eventable) == null ? $opal.cm('Eventable') : $a));

      self.$reactive_accessor("connected", "status", "error", "reconnect_interval", "retry_count", "reconnect_in");

      def.$initialize = function() {
        var self = this;

        self.socket = nil;
        self['$status=']("opening");
        self['$connected='](false);
        self['$error='](nil);
        self['$retry_count='](0);
        self.queue = [];
        return self['$connect!']();
      };

      def['$connected?'] = function() {
        var self = this;

        return self.$connected();
      };

      def['$connect!'] = function() {
        var self = this;

        
        this.socket = new SockJS('/channel');

        this.socket.onopen = function() {
          self.$opened();
        };

        this.socket.onmessage = function(message) {
          self['$message_received'](message.data);
        };

        this.socket.onclose = function(error) {
          self.$closed(error);
        };
      
      };

      def.$opened = function() {
        var $a, $b, TMP_1, self = this;

        self['$status=']("open");
        self['$connected='](true);
        self['$reconnect_interval='](nil);
        self['$retry_count='](0);
        return ($a = ($b = self.queue).$each, $a._p = (TMP_1 = function(message){var self = TMP_1._s || this;
if (message == null) message = nil;
        return self.$send_message(message)}, TMP_1._s = self, TMP_1), $a).call($b);
      };

      def.$closed = function(error) {
        var self = this;

        self['$status=']("closed");
        self['$connected='](false);
        self['$error='](error.reason);
        return self['$reconnect!']();
      };

      def['$reconnect!'] = function() {
        var $a, $b, self = this, interval = nil;

        self['$status=']("reconnecting");
        ($a = self, ((($b = $a.$reconnect_interval()) !== false && $b !== nil) ? $b : $a['$reconnect_interval='](0)));
        ($a = self, $a['$reconnect_interval=']($a.$reconnect_interval()['$+'](((1000)['$+'](self.$rand(5000))))));
        ($a = self, $a['$retry_count=']($a.$retry_count()['$+'](1)));
        interval = self.$reconnect_interval();
        self['$reconnect_in='](interval);
        return self.$reconnect_tick();
      };

      def.$message_received = function(message) {
        var $a, self = this;

        message = (($a = $scope.JSON) == null ? $opal.cm('JSON') : $a).$parse(message);
        return ($a = self)['$trigger!'].apply($a, ["message"].concat(message));
      };

      def.$send_message = function(message) {
        var $a, self = this;

        if ((($a = self.$status()['$==']("open")['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
          return self.queue['$<<'](message)
          } else {
          message = (($a = $scope.JSON) == null ? $opal.cm('JSON') : $a).$dump([message]);
          
          this.socket.send(message);
        
        };
      };

      def['$close!'] = function() {
        var self = this;

        self['$status=']("closed");
        
        this.socket.close();
      
      };

      self.$private();

      return (def.$reconnect_tick = function() {
        var $a, self = this;

        if (self.$reconnect_in()['$>='](1000)) {
          ($a = self, $a['$reconnect_in=']($a.$reconnect_in()['$-'](1000)));
          
        setTimeout(function() {
          self['$reconnect_tick']();
        }, 1000);
        
          } else {
          return self['$connect!']()
        };
      }, nil) && 'reconnect_tick';
    })(self, null)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$[]', '$==', '$inspect']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $Environment(){};
      var self = $Environment = $klass($base, $super, 'Environment', $Environment);

      var def = self._proto, $scope = self._scope;

      def.env = nil;
      def.$initialize = function() {
        var $a, self = this;

        self.env = (($a = $scope.ENV) == null ? $opal.cm('ENV') : $a)['$[]']("VOLT_ENV");
        if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
          if ((($a = self.env) !== nil && (!$a._isBoolean || $a == true))) {
            } else {
            if (window.start_env) {;
            self.env = window.start_env;
            };
          }};
        return ((($a = self.env) !== false && $a !== nil) ? $a : self.env = "development");
      };

      def['$=='] = function(val) {
        var self = this;

        return self.env['$=='](val);
      };

      def['$production?'] = function() {
        var self = this;

        return self['$==']("production");
      };

      def['$test?'] = function() {
        var self = this;

        return self['$==']("test");
      };

      def['$development?'] = function() {
        var self = this;

        return self['$==']("development");
      };

      def.$inspect = function() {
        var self = this;

        return self.env.$inspect();
      };

      return (def.$to_s = function() {
        var self = this;

        return self.env;
      }, nil) && 'to_s';
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$run_in', '$call', '$run_without_tracking', '$<<', '$!', '$in_browser?', '$queue_flush!', '$class', '$each', '$to_proc', '$invalidate!', '$current', '$current=', '$fail', '$new']);
  (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $Computation(){};
      var self = $Computation = $klass($base, $super, 'Computation', $Computation);

      var def = self._proto, $scope = self._scope, TMP_2, TMP_4, TMP_5;

      def.stopped = def.invalidated = def.invalidations = def.computing = nil;
      ($opal.cvars['@@current'] = nil);

      ($opal.cvars['@@flush_queue'] = []);

      $opal.defs(self, '$current=', function(val) {
        var self = this;

        return ($opal.cvars['@@current'] = val);
      });

      $opal.defs(self, '$current', function() {
        var $a, self = this;

        return (($a = $opal.cvars['@@current']) == null ? nil : $a);
      });

      def.$initialize = function(computation) {
        var self = this;

        self.computation = computation;
        return self.invalidations = [];
      };

      def['$compute!'] = function() {
        var $a, $b, TMP_1, self = this;

        self.invalidated = false;
        if ((($a = self.stopped) !== nil && (!$a._isBoolean || $a == true))) {
          return nil
          } else {
          self.computing = true;
          ($a = ($b = self).$run_in, $a._p = (TMP_1 = function(){var self = TMP_1._s || this;
            if (self.computation == null) self.computation = nil;

          return self.computation.$call()}, TMP_1._s = self, TMP_1), $a).call($b);
          return self.computing = false;
        };
      };

      def.$on_invalidate = TMP_2 = function() {
        var $a, $b, TMP_3, $c, self = this, $iter = TMP_2._p, callback = $iter || nil;

        TMP_2._p = null;
        if ((($a = self.invalidated) !== nil && (!$a._isBoolean || $a == true))) {
          return ($a = ($b = (($c = $scope.Computation) == null ? $opal.cm('Computation') : $c)).$run_without_tracking, $a._p = (TMP_3 = function(){var self = TMP_3._s || this;

          return callback.$call()}, TMP_3._s = self, TMP_3), $a).call($b)
          } else {
          return self.invalidations['$<<'](callback)
        };
      };

      def['$invalidate!'] = function() {
        var $a, $b, self = this, invalidations = nil;

        if ((($a = self.invalidated) !== nil && (!$a._isBoolean || $a == true))) {
          return nil
          } else {
          self.invalidated = true;
          if ((($a = ($b = self.stopped['$!'](), $b !== false && $b !== nil ?self.computing['$!']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            (($a = $opal.cvars['@@flush_queue']) == null ? nil : $a)['$<<'](self);
            if ((($a = (($b = $scope.Volt) == null ? $opal.cm('Volt') : $b)['$in_browser?']()) !== nil && (!$a._isBoolean || $a == true))) {
              self.$class()['$queue_flush!']()};};
          invalidations = self.invalidations;
          self.invalidations = [];
          return ($a = ($b = invalidations).$each, $a._p = "call".$to_proc(), $a).call($b);
        };
      };

      def.$stop = function() {
        var $a, self = this;

        if ((($a = self.stopped) !== nil && (!$a._isBoolean || $a == true))) {
          return nil
          } else {
          self.stopped = true;
          return self['$invalidate!']();
        };
      };

      def.$run_in = TMP_4 = function() {
        var $a, self = this, $iter = TMP_4._p, $yield = $iter || nil, previous = nil;

        TMP_4._p = null;
        previous = (($a = $scope.Computation) == null ? $opal.cm('Computation') : $a).$current();
        (($a = $scope.Computation) == null ? $opal.cm('Computation') : $a)['$current='](self);
        if ($opal.$yieldX($yield, []) === $breaker) return $breaker.$v;
        (($a = $scope.Computation) == null ? $opal.cm('Computation') : $a)['$current='](previous);
        return self;
      };

      $opal.defs(self, '$run_without_tracking', TMP_5 = function() {
        var $a, self = this, $iter = TMP_5._p, $yield = $iter || nil, previous = nil, return_value = nil;

        TMP_5._p = null;
        previous = (($a = $scope.Computation) == null ? $opal.cm('Computation') : $a).$current();
        (($a = $scope.Computation) == null ? $opal.cm('Computation') : $a)['$current='](nil);
        return_value = ((($a = $opal.$yieldX($yield, [])) === $breaker) ? $breaker.$v : $a);
        (($a = $scope.Computation) == null ? $opal.cm('Computation') : $a)['$current='](previous);
        return return_value;
      });

      $opal.defs(self, '$flush!', function() {
        var $a, $b, self = this, computations = nil;
        if (self.flushing == null) self.flushing = nil;

        if ((($a = self.flushing) !== nil && (!$a._isBoolean || $a == true))) {
          self.$fail("Can't flush while in a flush")};
        self.flushing = true;
        self.timer = nil;
        computations = (($a = $opal.cvars['@@flush_queue']) == null ? nil : $a);
        ($opal.cvars['@@flush_queue'] = []);
        ($a = ($b = computations).$each, $a._p = "compute!".$to_proc(), $a).call($b);
        return self.flushing = false;
      });

      return ($opal.defs(self, '$queue_flush!', function() {
        var $a, self = this;
        if (self.timer == null) self.timer = nil;

        if ((($a = self.timer) !== nil && (!$a._isBoolean || $a == true))) {
          return nil
          } else {
          return self.timer = setImmediate(function() { self['$flush!'](); });
        };
      }), nil) && 'queue_flush!';
    })(self, null)
    
  })(self);
  return (function($base, $super) {
    function $Proc(){};
    var self = $Proc = $klass($base, $super, 'Proc', $Proc);

    var def = self._proto, $scope = self._scope;

    return (def['$watch!'] = function() {
      var $a, $b, TMP_6, $c, $d, self = this;

      return ($a = ($b = (($c = ((($d = $scope.Volt) == null ? $opal.cm('Volt') : $d))._scope).Computation == null ? $c.cm('Computation') : $c.Computation).$new(self)).$run_in, $a._p = (TMP_6 = function(){var self = TMP_6._s || this;

      return self.$call()}, TMP_6._s = self, TMP_6), $a).call($b);
    }, nil) && 'watch!'
  })(self, null);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $module = $opal.module;

  $opal.add_stubs(['$include', '$new', '$nil?', '$do_with_enum', '$add', '$[]', '$merge', '$equal?', '$instance_of?', '$class', '$==', '$instance_variable_get', '$is_a?', '$size', '$all?', '$include?', '$[]=', '$enum_for', '$each_key', '$to_proc', '$empty?', '$clear', '$each', '$keys']);
  (function($base, $super) {
    function $Set(){};
    var self = $Set = $klass($base, $super, 'Set', $Set);

    var def = self._proto, $scope = self._scope, $a, TMP_1, TMP_4, TMP_6;

    def.hash = nil;
    self.$include((($a = $scope.Enumerable) == null ? $opal.cm('Enumerable') : $a));

    $opal.defs(self, '$[]', function(ary) {
      var self = this;

      ary = $slice.call(arguments, 0);
      return self.$new(ary);
    });

    def.$initialize = TMP_1 = function(enum$) {
      var $a, $b, TMP_2, self = this, $iter = TMP_1._p, block = $iter || nil;

      if (enum$ == null) {
        enum$ = nil
      }
      TMP_1._p = null;
      self.hash = (($a = $scope.Hash) == null ? $opal.cm('Hash') : $a).$new();
      if ((($a = enum$['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
        return nil};
      if (block !== false && block !== nil) {
        return ($a = ($b = self).$do_with_enum, $a._p = (TMP_2 = function(o){var self = TMP_2._s || this;
if (o == null) o = nil;
        return self.$add(block['$[]'](o))}, TMP_2._s = self, TMP_2), $a).call($b, enum$)
        } else {
        return self.$merge(enum$)
      };
    };

    def['$=='] = function(other) {
      var $a, $b, $c, TMP_3, self = this;

      if ((($a = self['$equal?'](other)) !== nil && (!$a._isBoolean || $a == true))) {
        return true
      } else if ((($a = other['$instance_of?'](self.$class())) !== nil && (!$a._isBoolean || $a == true))) {
        return self.hash['$=='](other.$instance_variable_get("@hash"))
      } else if ((($a = ($b = other['$is_a?']((($c = $scope.Set) == null ? $opal.cm('Set') : $c)), $b !== false && $b !== nil ?self.$size()['$=='](other.$size()) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
        return ($a = ($b = other)['$all?'], $a._p = (TMP_3 = function(o){var self = TMP_3._s || this;
          if (self.hash == null) self.hash = nil;
if (o == null) o = nil;
        return self.hash['$include?'](o)}, TMP_3._s = self, TMP_3), $a).call($b)
        } else {
        return false
      };
    };

    def.$add = function(o) {
      var self = this;

      self.hash['$[]='](o, true);
      return self;
    };

    $opal.defn(self, '$<<', def.$add);

    def['$add?'] = function(o) {
      var $a, self = this;

      if ((($a = self['$include?'](o)) !== nil && (!$a._isBoolean || $a == true))) {
        return nil
        } else {
        return self.$add(o)
      };
    };

    def.$each = TMP_4 = function() {
      var $a, $b, self = this, $iter = TMP_4._p, block = $iter || nil;

      TMP_4._p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each")
      };
      ($a = ($b = self.hash).$each_key, $a._p = block.$to_proc(), $a).call($b);
      return self;
    };

    def['$empty?'] = function() {
      var self = this;

      return self.hash['$empty?']();
    };

    def.$clear = function() {
      var self = this;

      self.hash.$clear();
      return self;
    };

    def['$include?'] = function(o) {
      var self = this;

      return self.hash['$include?'](o);
    };

    $opal.defn(self, '$member?', def['$include?']);

    def.$merge = function(enum$) {
      var $a, $b, TMP_5, self = this;

      ($a = ($b = self).$do_with_enum, $a._p = (TMP_5 = function(o){var self = TMP_5._s || this;
if (o == null) o = nil;
      return self.$add(o)}, TMP_5._s = self, TMP_5), $a).call($b, enum$);
      return self;
    };

    def.$do_with_enum = TMP_6 = function(enum$) {
      var $a, $b, self = this, $iter = TMP_6._p, block = $iter || nil;

      TMP_6._p = null;
      return ($a = ($b = enum$).$each, $a._p = block.$to_proc(), $a).call($b);
    };

    def.$size = function() {
      var self = this;

      return self.hash.$size();
    };

    $opal.defn(self, '$length', def.$size);

    return (def.$to_a = function() {
      var self = this;

      return self.hash.$keys();
    }, nil) && 'to_a';
  })(self, null);
  return (function($base) {
    var self = $module($base, 'Enumerable');

    var def = self._proto, $scope = self._scope, TMP_7;

    def.$to_set = TMP_7 = function(klass, args) {
      var $a, $b, self = this, $iter = TMP_7._p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      if (klass == null) {
        klass = (($a = $scope.Set) == null ? $opal.cm('Set') : $a)
      }
      TMP_7._p = null;
      return ($a = ($b = klass).$new, $a._p = block.$to_proc(), $a).apply($b, [self].concat(args));
    }
        ;$opal.donate(self, ["$to_set"]);
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $module = $opal.module;

  $opal.add_stubs(['$delete', '$include?', '$enum_for', '$each', '$select', '$keys', '$new', '$current', '$add?', '$on_invalidate', '$to_proc', '$changed!']);
  ;
  (function($base, $super) {
    function $Set(){};
    var self = $Set = $klass($base, $super, 'Set', $Set);

    var def = self._proto, $scope = self._scope, TMP_1;

    def.hash = nil;
    def.$delete = function(o) {
      var self = this;

      return self.hash.$delete(o);
    };

    def['$delete?'] = function(o) {
      var $a, self = this;

      if ((($a = self['$include?'](o)) !== nil && (!$a._isBoolean || $a == true))) {
        return self.$delete(o)
        } else {
        return nil
      };
    };

    def.$delete_if = TMP_1 = function() {try {

      var $a, $b, TMP_2, $c, $d, TMP_3, self = this, $iter = TMP_1._p, $yield = $iter || nil;

      TMP_1._p = null;
      ((($a = ($yield !== nil)) !== false && $a !== nil) ? $a : $opal.$return(self.$enum_for("delete_if")));
      ($a = ($b = ($c = ($d = self).$select, $c._p = (TMP_3 = function(o){var self = TMP_3._s || this, $a;
if (o == null) o = nil;
      return $a = $opal.$yield1($yield, o), $a === $breaker ? $a : $a}, TMP_3._s = self, TMP_3), $c).call($d)).$each, $a._p = (TMP_2 = function(o){var self = TMP_2._s || this;
        if (self.hash == null) self.hash = nil;
if (o == null) o = nil;
      return self.hash.$delete(o)}, TMP_2._s = self, TMP_2), $a).call($b);
      return self;
      } catch ($returner) { if ($returner === $opal.returner) { return $returner.$v } throw $returner; }
    };

    return (def.$to_a = function() {
      var self = this;

      return self.hash.$keys();
    }, nil) && 'to_a';
  })(self, null);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $Dependency(){};
      var self = $Dependency = $klass($base, $super, 'Dependency', $Dependency);

      var def = self._proto, $scope = self._scope;

      def.dependencies = nil;
      def.$initialize = function() {
        var $a, self = this;

        return self.dependencies = (($a = $scope.Set) == null ? $opal.cm('Set') : $a).$new();
      };

      def.$depend = function() {
        var $a, $b, TMP_4, self = this, current = nil, added = nil;

        if ((($a = self.dependencies) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          return nil
        };
        current = (($a = $scope.Computation) == null ? $opal.cm('Computation') : $a).$current();
        if (current !== false && current !== nil) {
          added = self.dependencies['$add?'](current);
          if (added !== false && added !== nil) {
            return ($a = ($b = current).$on_invalidate, $a._p = (TMP_4 = function(){var self = TMP_4._s || this, $a;
              if (self.dependencies == null) self.dependencies = nil;

            if ((($a = self.dependencies) !== nil && (!$a._isBoolean || $a == true))) {
                return self.dependencies.$delete(current)
                } else {
                return nil
              }}, TMP_4._s = self, TMP_4), $a).call($b)
            } else {
            return nil
          };
          } else {
          return nil
        };
      };

      def['$changed!'] = function() {
        var $a, $b, self = this, deps = nil;

        deps = self.dependencies;
        if (deps !== false && deps !== nil) {
          } else {
          return nil
        };
        self.dependencies = (($a = $scope.Set) == null ? $opal.cm('Set') : $a).$new();
        return ($a = ($b = deps).$each, $a._p = "invalidate!".$to_proc(), $a).call($b);
      };

      return (def.$remove = function() {
        var self = this;

        self['$changed!']();
        return self.dependencies = nil;
      }, nil) && 'remove';
    })(self, null)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $hash2 = $opal.hash2, $range = $opal.range;

  $opal.add_stubs(['$each_pair', '$[]=', '$to_sym', '$[]', '$end_with?', '$enum_for', '$is_a?', '$==', '$instance_variable_get', '$===', '$eql?', '$dup', '$to_n', '$hash', '$class', '$join', '$map', '$inspect']);
  return (function($base, $super) {
    function $OpenStruct(){};
    var self = $OpenStruct = $klass($base, $super, 'OpenStruct', $OpenStruct);

    var def = self._proto, $scope = self._scope, TMP_2;

    def.table = nil;
    def.$initialize = function(hash) {
      var $a, $b, TMP_1, self = this;

      if (hash == null) {
        hash = nil
      }
      self.table = $hash2([], {});
      if (hash !== false && hash !== nil) {
        return ($a = ($b = hash).$each_pair, $a._p = (TMP_1 = function(key, value){var self = TMP_1._s || this;
          if (self.table == null) self.table = nil;
if (key == null) key = nil;if (value == null) value = nil;
        return self.table['$[]='](key.$to_sym(), value)}, TMP_1._s = self, TMP_1), $a).call($b)
        } else {
        return nil
      };
    };

    def['$[]'] = function(name) {
      var self = this;

      return self.table['$[]'](name.$to_sym());
    };

    def['$[]='] = function(name, value) {
      var self = this;

      return self.table['$[]='](name.$to_sym(), value);
    };

    def.$method_missing = function(name, args) {
      var $a, self = this;

      args = $slice.call(arguments, 1);
      if ((($a = name['$end_with?']("=")) !== nil && (!$a._isBoolean || $a == true))) {
        return self.table['$[]='](name['$[]']($range(0, -2, false)).$to_sym(), args['$[]'](0))
        } else {
        return self.table['$[]'](name.$to_sym())
      };
    };

    def.$each_pair = TMP_2 = function() {
      var $a, $b, TMP_3, self = this, $iter = TMP_2._p, $yield = $iter || nil;

      TMP_2._p = null;
      if (($yield !== nil)) {
        } else {
        return self.$enum_for("each_pair")
      };
      return ($a = ($b = self.table).$each_pair, $a._p = (TMP_3 = function(pair){var self = TMP_3._s || this, $a;
if (pair == null) pair = nil;
      return $a = $opal.$yield1($yield, pair), $a === $breaker ? $a : $a}, TMP_3._s = self, TMP_3), $a).call($b);
    };

    def['$=='] = function(other) {
      var $a, $b, self = this;

      if ((($a = other['$is_a?']((($b = $scope.OpenStruct) == null ? $opal.cm('OpenStruct') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      return self.table['$=='](other.$instance_variable_get("@table"));
    };

    def['$==='] = function(other) {
      var $a, $b, self = this;

      if ((($a = other['$is_a?']((($b = $scope.OpenStruct) == null ? $opal.cm('OpenStruct') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      return self.table['$==='](other.$instance_variable_get("@table"));
    };

    def['$eql?'] = function(other) {
      var $a, $b, self = this;

      if ((($a = other['$is_a?']((($b = $scope.OpenStruct) == null ? $opal.cm('OpenStruct') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
        } else {
        return false
      };
      return self.table['$eql?'](other.$instance_variable_get("@table"));
    };

    def.$to_h = function() {
      var self = this;

      return self.table.$dup();
    };

    def.$to_n = function() {
      var self = this;

      return self.table.$to_n();
    };

    def.$hash = function() {
      var self = this;

      return self.table.$hash();
    };

    return (def.$inspect = function() {
      var $a, $b, TMP_4, self = this;

      return "#<" + (self.$class()) + ": " + (($a = ($b = self.$each_pair()).$map, $a._p = (TMP_4 = function(name, value){var self = TMP_4._s || this;
if (name == null) name = nil;if (value == null) value = nil;
      return "" + (name) + "=" + (self['$[]'](name).$inspect())}, TMP_4._s = self, TMP_4), $a).call($b).$join(" ")) + ">";
    }, nil) && 'inspect';
  })(self, null)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass, $module = $opal.module, $hash2 = $opal.hash2;

  $opal.add_stubs(['$==', '$key?', '$wrap_config', '$each_pair', '$is_a?', '$[]=', '$new']);
  if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
    ;
    (function($base, $super) {
      function $OpenStruct(){};
      var self = $OpenStruct = $klass($base, $super, 'OpenStruct', $OpenStruct);

      var def = self._proto, $scope = self._scope, TMP_1;

      def.table = nil;
      return (def['$respond_to?'] = TMP_1 = function(method_name) {var $zuper = $slice.call(arguments, 0);
        var $a, self = this, $iter = TMP_1._p, $yield = $iter || nil;

        TMP_1._p = null;
        return ((($a = self.table['$key?'](method_name)) !== false && $a !== nil) ? $a : $opal.find_super_dispatcher(self, 'respond_to?', TMP_1, $iter).apply(self, $zuper));
      }, nil) && 'respond_to?'
    })(self, null);
    return (function($base) {
      var self = $module($base, 'Volt');

      var def = self._proto, $scope = self._scope;

      (function(self) {
        var $scope = self._scope, def = self._proto;

        self._proto.$config = function() {
          var self = this;
          if (self.config == null) self.config = nil;

          return self.config;
        };
        self._proto.$setup_client_config = function(config_hash) {
          var self = this;

          return self.config = self.$wrap_config($hash2(["public"], {"public": config_hash}));
        };
        return (self._proto.$wrap_config = function(hash) {
          var $a, $b, TMP_2, self = this, new_hash = nil;

          new_hash = $hash2([], {});
          ($a = ($b = hash).$each_pair, $a._p = (TMP_2 = function(key, value){var self = TMP_2._s || this, $a, $b;
if (key == null) key = nil;if (value == null) value = nil;
          if ((($a = value['$is_a?']((($b = $scope.Hash) == null ? $opal.cm('Hash') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
              return new_hash['$[]='](key, self.$wrap_config(value))
              } else {
              return new_hash['$[]='](key, value)
            }}, TMP_2._s = self, TMP_2), $a).call($b);
          return (($a = $scope.OpenStruct) == null ? $opal.cm('OpenStruct') : $a).$new(new_hash);
        }, nil) && 'wrap_config';
      })(self.$singleton_class())
      
    })(self);}
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $range = $opal.range, $gvars = $opal.gvars, $hash2 = $opal.hash2;

  $opal.add_stubs(['$user_id_signature', '$nil?', '$index', '$[]', '$!', '$==', '$+', '$new', '$app_secret', '$config', '$raise', '$user', '$user_id', '$find_one', '$_users', '$store', '$then', '$_user_id=', '$cookies', '$login', '$delete', '$client?', '$_user_id', '$current']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function(self) {
      var $scope = self._scope, def = self._proto;

      self._proto.$user_id = function() {
        var $a, $b, $c, self = this, user_id_signature = nil, index = nil, user_id = nil, hash = nil;

        user_id_signature = self.$user_id_signature();
        if ((($a = user_id_signature['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
          return nil
          } else {
          index = user_id_signature.$index(":");
          user_id = user_id_signature['$[]']($range(0, index, true));
          if ((($a = (($b = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $b)['$==']("opal")['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
            hash = user_id_signature['$[]']($range((index['$+'](1)), -1, false));
            if ((($a = (($b = ((($c = $scope.BCrypt) == null ? $opal.cm('BCrypt') : $c))._scope).Password == null ? $b.cm('Password') : $b.Password).$new(hash)['$==']("" + ((($b = $scope.Volt) == null ? $opal.cm('Volt') : $b).$config().$app_secret()) + "::" + (user_id))['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
              self.$raise("user id or hash has been tampered with")};};
          return user_id;
        };
      };
      self._proto['$user?'] = function() {
        var self = this;

        return self.$user()['$!']()['$!']();
      };
      self._proto.$user = function() {
        var self = this, user_id = nil;
        if ($gvars.page == null) $gvars.page = nil;

        user_id = self.$user_id();
        if (user_id !== false && user_id !== nil) {
          return $gvars.page.$store().$_users().$find_one($hash2(["_id"], {"_id": user_id}))
          } else {
          return nil
        };
      };
      self._proto.$login = function(username, password) {
        var $a, $b, TMP_1, $c, self = this;

        return ($a = ($b = (($c = $scope.UserTasks) == null ? $opal.cm('UserTasks') : $c).$login(username, password)).$then, $a._p = (TMP_1 = function(result){var self = TMP_1._s || this;
          if ($gvars.page == null) $gvars.page = nil;
if (result == null) result = nil;
        $gvars.page.$cookies()['$_user_id='](result);
          return nil;}, TMP_1._s = self, TMP_1), $a).call($b);
      };
      self._proto.$logout = function() {
        var self = this;
        if ($gvars.page == null) $gvars.page = nil;

        return $gvars.page.$cookies().$delete("user_id");
      };
      return (self._proto.$user_id_signature = function() {
        var $a, $b, self = this, user_id_signature = nil, meta_data = nil;
        if ($gvars.page == null) $gvars.page = nil;

        if ((($a = (($b = $scope.Volt) == null ? $opal.cm('Volt') : $b)['$client?']()) !== nil && (!$a._isBoolean || $a == true))) {
          user_id_signature = $gvars.page.$cookies().$_user_id()
          } else {
          meta_data = (($a = $scope.Thread) == null ? $opal.cm('Thread') : $a).$current()['$[]']("meta");
          if (meta_data !== false && meta_data !== nil) {
            user_id_signature = meta_data['$[]']("user_id")
            } else {
            user_id_signature = nil
          };
        };
        return user_id_signature;
      }, nil) && 'user_id_signature';
    })(self.$singleton_class())
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module;

  $opal.add_stubs(['$==', '$expand_path', '$pwd', '$attr_writer', '$!', '$[]', '$new']);
  ;
  ;
  ;
  ;
  ;
  if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {};
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a;

    self.in_browser = (function() {if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
      return !!document && !window.OPAL_SPEC_PHANTOM;}; return nil; })();

    (function(self) {
      var $scope = self._scope, def = self._proto;

      self._proto.$root = function() {
        var $a, $b, self = this;
        if (self.root == null) self.root = nil;

        return ((($a = self.root) !== false && $a !== nil) ? $a : self.root = (($b = $scope.File) == null ? $opal.cm('File') : $b).$expand_path((($b = $scope.Dir) == null ? $opal.cm('Dir') : $b).$pwd()));
      };
      self.$attr_writer("root");
      self._proto['$server?'] = function() {
        var $a, self = this;

        return (($a = $scope.ENV) == null ? $opal.cm('ENV') : $a)['$[]']("SERVER")['$!']()['$!']();
      };
      self._proto['$client?'] = function() {
        var $a, self = this;

        return (($a = $scope.ENV) == null ? $opal.cm('ENV') : $a)['$[]']("SERVER")['$!']();
      };
      self._proto['$source_maps?'] = function() {
        var $a, self = this;

        return (($a = $scope.ENV) == null ? $opal.cm('ENV') : $a)['$[]']("MAPS")['$!']()['$!']();
      };
      self._proto.$env = function() {
        var $a, $b, $c, self = this;
        if (self.env == null) self.env = nil;

        return ((($a = self.env) !== false && $a !== nil) ? $a : self.env = (($b = ((($c = $scope.Volt) == null ? $opal.cm('Volt') : $c))._scope).Environment == null ? $b.cm('Environment') : $b.Environment).$new());
      };
      self._proto.$logger = function() {
        var $a, $b, self = this;
        if (self.logger == null) self.logger = nil;

        return ((($a = self.logger) !== false && $a !== nil) ? $a : self.logger = (($b = $scope.Logger) == null ? $opal.cm('Logger') : $b).$new((($b = $scope.STDOUT) == null ? $opal.cm('STDOUT') : $b)));
      };
      self.$attr_writer("logger");
      return (self._proto['$in_browser?'] = function() {
        var self = this;
        if (self.in_browser == null) self.in_browser = nil;

        return self.in_browser;
      }, nil) && 'in_browser?';
    })(self.$singleton_class());
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2, $range = $opal.range;

  $opal.add_stubs(['$instance_eval', '$to_proc', '$symbolize_keys', '$has_binding?', '$add_indirect_path', '$[]=', '$add_param_matcher', '$each_with_object', '$to_s', '$each', '$check_params_match', '$dup', '$[]', '$call', '$url_parts', '$match_path', '$private', '$nil?', '$setup_bindings_in_params', '$each_pair', '$is_a?', '$each_with_index', '$to_sym', '$strip', '$create_path_transformer', '$<<', '$lambda', '$join', '$map', '$delete', '$+', '$==', '$key?', '$reject', '$split', '$index']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $Routes(){};
      var self = $Routes = $klass($base, $super, 'Routes', $Routes);

      var def = self._proto, $scope = self._scope, TMP_1;

      def.direct_routes = def.param_matches = def.indirect_routes = nil;
      def.$initialize = function() {
        var self = this;

        self.direct_routes = $hash2([], {});
        self.indirect_routes = $hash2([], {});
        return self.param_matches = [];
      };

      def.$define = TMP_1 = function() {
        var $a, $b, self = this, $iter = TMP_1._p, block = $iter || nil;

        TMP_1._p = null;
        ($a = ($b = self).$instance_eval, $a._p = block.$to_proc(), $a).call($b);
        return self;
      };

      def.$get = function(path, params) {
        var $a, self = this;

        if (params == null) {
          params = $hash2([], {})
        }
        params = params.$symbolize_keys();
        if ((($a = self['$has_binding?'](path)) !== nil && (!$a._isBoolean || $a == true))) {
          self.$add_indirect_path(path, params)
          } else {
          self.direct_routes['$[]='](path, params)
        };
        return self.$add_param_matcher(path, params);
      };

      def.$params_to_url = function(test_params) {try {

        var $a, $b, TMP_2, $d, TMP_3, self = this;

        test_params = ($a = ($b = test_params).$each_with_object, $a._p = (TMP_2 = function($c, obj){var self = TMP_2._s || this;
k = $c[0];v = $c[1];if (obj == null) obj = nil;
        return obj['$[]='](("_" + k.$to_s()), v)}, TMP_2._s = self, TMP_2), $a).call($b, $hash2([], {}));
        ($a = ($d = self.param_matches).$each, $a._p = (TMP_3 = function(param_matcher){var self = TMP_3._s || this, $a, result = nil, new_params = nil;
if (param_matcher == null) param_matcher = nil;
        $a = $opal.to_ary(self.$check_params_match(test_params.$dup(), param_matcher['$[]'](0))), result = ($a[0] == null ? nil : $a[0]), new_params = ($a[1] == null ? nil : $a[1]);
          if (result !== false && result !== nil) {
            $opal.$return(param_matcher['$[]'](1).$call(new_params))
            } else {
            return nil
          };}, TMP_3._s = self, TMP_3), $a).call($d);
        return [nil, nil];
        } catch ($returner) { if ($returner === $opal.returner) { return $returner.$v } throw $returner; }
      };

      def.$url_to_params = function(path) {
        var self = this, result = nil, parts = nil;

        result = self.direct_routes['$[]'](path);
        if (result !== false && result !== nil) {
          return result};
        parts = self.$url_parts(path);
        return self.$match_path(parts, parts, self.indirect_routes);
      };

      self.$private();

      def.$match_path = function(original_parts, remaining_parts, node) {
        var $a, self = this, part = nil, parts = nil, new_node = nil;

        $a = $opal.to_ary(remaining_parts), part = ($a[0] == null ? nil : $a[0]), parts = $slice.call($a, 1);
        if ((($a = part['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
          if ((($a = node['$[]'](part)) !== nil && (!$a._isBoolean || $a == true))) {
            return self.$setup_bindings_in_params(original_parts, node['$[]'](part))
            } else {
            return false
          }
        } else if ((($a = (new_node = node['$[]'](part))) !== nil && (!$a._isBoolean || $a == true))) {
          return self.$match_path(original_parts, parts, new_node)
        } else if ((($a = (new_node = node['$[]']("*"))) !== nil && (!$a._isBoolean || $a == true))) {
          return self.$match_path(original_parts, parts, new_node)
          } else {
          return nil
        };
      };

      def.$setup_bindings_in_params = function(original_parts, params) {
        var $a, $b, TMP_4, self = this;

        params = params.$dup();
        ($a = ($b = params).$each_pair, $a._p = (TMP_4 = function(key, value){var self = TMP_4._s || this, $a, $b;
if (key == null) key = nil;if (value == null) value = nil;
        if ((($a = value['$is_a?']((($b = $scope.Fixnum) == null ? $opal.cm('Fixnum') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            return params['$[]='](key, original_parts['$[]'](value))
            } else {
            return nil
          }}, TMP_4._s = self, TMP_4), $a).call($b);
        return params;
      };

      def.$add_indirect_path = function(path, params) {
        var $a, $b, TMP_5, self = this, node = nil, parts = nil;

        node = self.indirect_routes;
        parts = self.$url_parts(path);
        ($a = ($b = parts).$each_with_index, $a._p = (TMP_5 = function(part, index){var self = TMP_5._s || this, $a, $b, $c;
if (part == null) part = nil;if (index == null) index = nil;
        if ((($a = self['$has_binding?'](part)) !== nil && (!$a._isBoolean || $a == true))) {
            params['$[]='](part['$[]']($range(2, -2, true)).$strip().$to_sym(), index);
            part = "*";};
          return node = (($a = part, $b = node, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, $hash2([], {})))));}, TMP_5._s = self, TMP_5), $a).call($b);
        return node['$[]='](nil, params);
      };

      def.$add_param_matcher = function(path, params) {
        var $a, $b, TMP_6, self = this, parts = nil, path_transformer = nil;

        params = params.$dup();
        parts = self.$url_parts(path);
        ($a = ($b = parts).$each_with_index, $a._p = (TMP_6 = function(part, index){var self = TMP_6._s || this, $a;
if (part == null) part = nil;if (index == null) index = nil;
        if ((($a = self['$has_binding?'](part)) !== nil && (!$a._isBoolean || $a == true))) {
            return params['$[]='](part['$[]']($range(2, -2, true)).$strip().$to_sym(), nil)
            } else {
            return nil
          }}, TMP_6._s = self, TMP_6), $a).call($b);
        path_transformer = self.$create_path_transformer(parts);
        return self.param_matches['$<<']([params, path_transformer]);
      };

      def.$create_path_transformer = function(parts) {try {

        var $a, $b, TMP_7, self = this;

        return ($a = ($b = self).$lambda, $a._p = (TMP_7 = function(input_params){var self = TMP_7._s || this, $a, $b, TMP_8, url = nil;
if (input_params == null) input_params = nil;
        input_params = input_params.$dup();
          url = ($a = ($b = parts).$map, $a._p = (TMP_8 = function(part){var self = TMP_8._s || this, $a, val = nil, binding = nil;
if (part == null) part = nil;
          val = (function() {if ((($a = self['$has_binding?'](part)) !== nil && (!$a._isBoolean || $a == true))) {
              binding = part['$[]']($range(2, -2, true)).$strip().$to_sym();
              return input_params.$delete(binding);
              } else {
              return part
            }; return nil; })();
            return val;}, TMP_8._s = self, TMP_8), $a).call($b).$join("/");
          $opal.$return(["/"['$+'](url), input_params]);}, TMP_7._s = self, TMP_7), $a).call($b);
        } catch ($returner) { if ($returner === $opal.returner) { return $returner.$v } throw $returner; }
      };

      def.$check_params_match = function(test_params, param_matcher) {try {

        var $a, $b, TMP_9, self = this;

        ($a = ($b = param_matcher).$each_pair, $a._p = (TMP_9 = function(key, value){var self = TMP_9._s || this, $a, $b, result = nil;
if (key == null) key = nil;if (value == null) value = nil;
        if ((($a = value['$is_a?']((($b = $scope.Hash) == null ? $opal.cm('Hash') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = test_params['$[]'](key)) !== nil && (!$a._isBoolean || $a == true))) {
              result = self.$check_params_match(test_params['$[]'](key), value);
              if (result['$=='](false)) {
                $opal.$return(false)
                } else {
                return test_params.$delete(key)
              };
              } else {
              $opal.$return(false)
            }
          } else if ((($a = value['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = test_params['$key?'](key)) !== nil && (!$a._isBoolean || $a == true))) {
              return nil
              } else {
              $opal.$return(false)
            }
          } else if (test_params['$[]'](key)['$=='](value)) {
            return test_params.$delete(key)
            } else {
            $opal.$return(false)
          }}, TMP_9._s = self, TMP_9), $a).call($b);
        return [true, test_params];
        } catch ($returner) { if ($returner === $opal.returner) { return $returner.$v } throw $returner; }
      };

      def.$url_parts = function(path) {
        var $a, $b, self = this;

        return ($a = ($b = path.$split("/")).$reject, $a._p = "blank?".$to_proc(), $a).call($b);
      };

      return (def['$has_binding?'] = function(string) {
        var $a, self = this;

        return ($a = string.$index("{{"), $a !== false && $a !== nil ?string.$index("}}") : $a);
      }, nil) && 'has_binding?';
    })(self, null)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2, $range = $opal.range;

  $opal.add_stubs(['$include', '$reactive_accessor', '$attr_accessor', '$new', '$==', '$[]', '$fragment=', '$update!', '$=~', '$+', '$match', '$scheme=', '$split', '$host=', '$port=', '$to_i', '$path=', '$query=', '$assign_query_hash_to_params', '$scroll', '$host', '$port', '$!', '$params_to_url', '$scheme', '$chomp', '$empty?', '$each_pair', '$<<', '$nested_params_hash', '$>', '$size', '$join', '$fragment', '$present?', '$url_for', '$merge', '$to_h', '$client?', '$private', '$query_hash', '$url_to_params', '$path', '$fail', '$merge!', '$assign_from_old', '$assign_new', '$is_a?', '$send', '$to_s', '$delete', '$attributes', '$each', '$query', '$reject', '$[]=', '$query_key_sections', '$each_with_index', '$-', '$map', '$to_proc', '$nil?', '$respond_to?', '$persistor', '$query_key']);
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $URL(){};
      var self = $URL = $klass($base, $super, 'URL', $URL);

      var def = self._proto, $scope = self._scope, $a;

      def.router = def.params = nil;
      self.$include((($a = $scope.ReactiveAccessors) == null ? $opal.cm('ReactiveAccessors') : $a));

      self.$reactive_accessor("scheme", "host", "port", "path", "query", "params", "fragment");

      self.$attr_accessor("router");

      def.$initialize = function(router) {
        var $a, $b, self = this;

        if (router == null) {
          router = nil
        }
        self.router = router;
        return self.params = (($a = $scope.Model) == null ? $opal.cm('Model') : $a).$new($hash2([], {}), $hash2(["persistor"], {"persistor": (($a = ((($b = $scope.Persistors) == null ? $opal.cm('Persistors') : $b))._scope).Params == null ? $a.cm('Params') : $a.Params)}));
      };

      def.$parse = function(url) {
        var $a, $b, self = this, host = nil, protocol = nil, matcher = nil, port = nil, path = nil, fragment = nil, query = nil;

        if (url['$[]'](0)['$==']("#")) {
          self['$fragment='](url['$[]']($range(1, -1, false)));
          self['$update!']();
          } else {
          host = document.location.host;
          protocol = document.location.protocol;
          if ((($a = ($b = url['$=~'](/[:]\/\//), ($b === nil || $b === false))) !== nil && (!$a._isBoolean || $a == true))) {
            url = protocol['$+']("//" + (host))['$+'](url)
          } else if ((($a = ($b = url['$=~']((new RegExp("" + protocol + "\\/\\/" + host))), ($b === nil || $b === false))) !== nil && (!$a._isBoolean || $a == true))) {
            return false};
          matcher = url.$match((new RegExp("^(" + protocol['$[]']($range(0, -2, false)) + ")[:]\\/\\/([^\\/]+)(.*)$")));
          self['$scheme='](matcher['$[]'](1));
          $a = $opal.to_ary(matcher['$[]'](2).$split(":")), self['$host='](($a[0] == null ? nil : $a[0])), port = ($a[1] == null ? nil : $a[1]);
          self['$port=']((((($a = port) !== false && $a !== nil) ? $a : 80)).$to_i());
          path = matcher['$[]'](3);
          $a = $opal.to_ary(path.$split("#", 2)), path = ($a[0] == null ? nil : $a[0]), fragment = ($a[1] == null ? nil : $a[1]);
          $a = $opal.to_ary(path.$split("?", 2)), path = ($a[0] == null ? nil : $a[0]), query = ($a[1] == null ? nil : $a[1]);
          self['$path='](path);
          self['$fragment='](fragment);
          self['$query='](query);
          self.$assign_query_hash_to_params();
        };
        self.$scroll();
        return true;
      };

      def.$url_for = function(params) {
        var $a, $b, TMP_1, self = this, host_with_port = nil, path = nil, new_url = nil, params_str = nil, query_parts = nil, query = nil, frag = nil;

        host_with_port = self.$host();
        if ((($a = ($b = self.$port(), $b !== false && $b !== nil ?self.$port()['$=='](80)['$!']() : $b)) !== nil && (!$a._isBoolean || $a == true))) {
          host_with_port = host_with_port['$+'](":" + (self.$port()))};
        $a = $opal.to_ary(self.router.$params_to_url(params)), path = ($a[0] == null ? nil : $a[0]), params = ($a[1] == null ? nil : $a[1]);
        new_url = "" + (self.$scheme()) + "://" + (host_with_port) + (path.$chomp("/"));
        params_str = "";
        if ((($a = params['$empty?']()) !== nil && (!$a._isBoolean || $a == true))) {
          } else {
          query_parts = [];
          ($a = ($b = self.$nested_params_hash(params)).$each_pair, $a._p = (TMP_1 = function(key, value){var self = TMP_1._s || this;
if (key == null) key = nil;if (value == null) value = nil;
          value = encodeURI(value);
            return query_parts['$<<']("" + (key['$[]']($range(1, -1, false))) + "=" + (value));}, TMP_1._s = self, TMP_1), $a).call($b);
          if (query_parts.$size()['$>'](0)) {
            query = query_parts.$join("&");
            new_url = new_url['$+']("?"['$+'](query));};
        };
        frag = self.$fragment();
        if ((($a = frag['$present?']()) !== nil && (!$a._isBoolean || $a == true))) {
          new_url = new_url['$+']("#"['$+'](frag))};
        return new_url;
      };

      def.$url_with = function(params) {
        var self = this;

        return self.$url_for(self.params.$to_h().$merge(params));
      };

      def['$update!'] = function() {
        var $a, $b, self = this, new_url = nil;

        if ((($a = (($b = $scope.Volt) == null ? $opal.cm('Volt') : $b)['$client?']()) !== nil && (!$a._isBoolean || $a == true))) {
          new_url = self.$url_for(self.params.$to_h());
          
        if (document.location.href != new_url && history && history.pushState) {
          history.pushState(null, null, new_url);
        }
      
          } else {
          return nil
        };
      };

      def.$scroll = function() {
        var $a, $b, self = this, frag = nil;

        if ((($a = (($b = $scope.Volt) == null ? $opal.cm('Volt') : $b)['$client?']()) !== nil && (!$a._isBoolean || $a == true))) {
          frag = self.$fragment();
          if ((($a = frag['$present?']()) !== nil && (!$a._isBoolean || $a == true))) {
            
          var anchor = $('#' + frag);
          if (anchor.length == 0) {
            anchor = $('*[name="' + frag + '"]:first');
          }
          if (anchor && anchor.length > 0) {
            console.log('scroll to: ', anchor.offset().top);
            $(document.body).scrollTop(anchor.offset().top);
          }
        
            } else {
            $(document.body).scrollTop(0);
          };
          } else {
          return nil
        };
      };

      self.$private();

      def.$assign_query_hash_to_params = function() {
        var self = this, query_hash = nil, new_params = nil;

        query_hash = self.$query_hash();
        new_params = self.router.$url_to_params(self.$path());
        if (new_params['$=='](false)) {
          self.$fail("no routes match path: " + (self.$path()))};
        query_hash['$merge!'](new_params);
        self.$assign_from_old(self.params, query_hash);
        return self.$assign_new(self.params, query_hash);
      };

      def.$assign_from_old = function(params, new_params) {
        var $a, $b, TMP_2, $c, TMP_3, self = this, queued_deletes = nil;

        queued_deletes = [];
        ($a = ($b = params.$attributes()).$each_pair, $a._p = (TMP_2 = function(name, old_val){var self = TMP_2._s || this, $a, $b, new_val = nil;
if (name == null) name = nil;if (old_val == null) old_val = nil;
        new_val = (function() {if (new_params !== false && new_params !== nil) {
            return new_params['$[]'](name)
            } else {
            return nil
          }; return nil; })();
          if ((($a = new_val['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
            return queued_deletes['$<<'](name)
          } else if ((($a = new_val['$is_a?']((($b = $scope.Hash) == null ? $opal.cm('Hash') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            return self.$assign_from_old(old_val, new_val)
            } else {
            if ((($a = old_val['$=='](new_val)['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
              params.$send(("" + name.$to_s() + "="), new_val)};
            return new_params.$delete(name);
          };}, TMP_2._s = self, TMP_2), $a).call($b);
        return ($a = ($c = queued_deletes).$each, $a._p = (TMP_3 = function(name){var self = TMP_3._s || this;
if (name == null) name = nil;
        return params.$delete(name)}, TMP_3._s = self, TMP_3), $a).call($c);
      };

      def.$assign_new = function(params, new_params) {
        var $a, $b, TMP_4, self = this;

        return ($a = ($b = new_params).$each_pair, $a._p = (TMP_4 = function(name, value){var self = TMP_4._s || this, $a, $b;
if (name == null) name = nil;if (value == null) value = nil;
        if ((($a = value['$is_a?']((($b = $scope.Hash) == null ? $opal.cm('Hash') : $b))) !== nil && (!$a._isBoolean || $a == true))) {
            return self.$assign_new(params.$send(name), value)
            } else {
            return params.$send(("" + name.$to_s() + "="), value)
          }}, TMP_4._s = self, TMP_4), $a).call($b);
      };

      def.$query_hash = function() {
        var $a, $b, TMP_5, $c, $d, TMP_8, self = this, query_hash = nil, qury = nil;

        query_hash = $hash2([], {});
        qury = self.$query();
        if (qury !== false && qury !== nil) {
          ($a = ($b = ($c = ($d = qury.$split("&")).$reject, $c._p = (TMP_8 = function(v){var self = TMP_8._s || this;
if (v == null) v = nil;
          return v['$==']("")}, TMP_8._s = self, TMP_8), $c).call($d)).$each, $a._p = (TMP_5 = function(part){var self = TMP_5._s || this, $a, $b, TMP_6, $c, TMP_7, parts = nil, sections = nil, hash_part = nil;
if (part == null) part = nil;
          parts = ($a = ($b = part.$split("=")).$reject, $a._p = (TMP_6 = function(v){var self = TMP_6._s || this;
if (v == null) v = nil;
            return v['$==']("")}, TMP_6._s = self, TMP_6), $a).call($b);
            parts['$[]='](1, decodeURI(parts[1]));
            sections = self.$query_key_sections(parts['$[]'](0));
            hash_part = query_hash;
            return ($a = ($c = sections).$each_with_index, $a._p = (TMP_7 = function(section, index){var self = TMP_7._s || this, $a, $b, $c;
if (section == null) section = nil;if (index == null) index = nil;
            if (index['$=='](sections.$size()['$-'](1))) {
                return hash_part['$[]='](section, parts['$[]'](1))
                } else {
                return hash_part = (($a = section, $b = hash_part, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, $hash2([], {})))))
              }}, TMP_7._s = self, TMP_7), $a).call($c);}, TMP_5._s = self, TMP_5), $a).call($b)};
        return query_hash;
      };

      def.$query_key_sections = function(key) {
        var $a, $b, TMP_9, $c, $d, self = this;

        return ($a = ($b = ($c = ($d = key.$split(/\[([^\]]+)\]/)).$reject, $c._p = "empty?".$to_proc(), $c).call($d)).$map, $a._p = (TMP_9 = function(v){var self = TMP_9._s || this;
if (v == null) v = nil;
        return ("_" + v.$to_s())}, TMP_9._s = self, TMP_9), $a).call($b);
      };

      def.$query_key = function(path) {
        var $a, $b, TMP_10, self = this, i = nil;

        i = 0;
        return ($a = ($b = path).$map, $a._p = (TMP_10 = function(v){var self = TMP_10._s || this, $a;
if (v == null) v = nil;
        i = i['$+'](1);
          if ((($a = i['$=='](1)['$!']()) !== nil && (!$a._isBoolean || $a == true))) {
            return "[" + (v) + "]"
            } else {
            return v
          };}, TMP_10._s = self, TMP_10), $a).call($b).$join("");
      };

      return (def.$nested_params_hash = function(params, path) {
        var $a, $b, TMP_11, self = this, results = nil;

        if (path == null) {
          path = []
        }
        results = $hash2([], {});
        ($a = ($b = params).$each_pair, $a._p = (TMP_11 = function(key, value){var self = TMP_11._s || this, $a, $b, $c, $d;
if (key == null) key = nil;if (value == null) value = nil;
        if ((($a = value['$nil?']()) !== nil && (!$a._isBoolean || $a == true))) {
            return nil
          } else if ((($a = ($b = ($c = value['$respond_to?']("persistor"), $c !== false && $c !== nil ?value.$persistor() : $c), $b !== false && $b !== nil ?value.$persistor()['$is_a?']((($c = ((($d = $scope.Persistors) == null ? $opal.cm('Persistors') : $d))._scope).Params == null ? $c.cm('Params') : $c.Params)) : $b)) !== nil && (!$a._isBoolean || $a == true))) {
            return results['$merge!'](self.$nested_params_hash(value, path['$+']([key])))
            } else {
            return results['$[]='](self.$query_key(path['$+']([key])), value)
          }}, TMP_11._s = self, TMP_11), $a).call($b);
        return results;
      }, nil) && 'nested_params_hash';
    })(self, null)
    
  })(self);
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass;

  $opal.add_stubs(['$client?', '$parse', '$url', '$update!']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $UrlTracker(){};
      var self = $UrlTracker = $klass($base, $super, 'UrlTracker', $UrlTracker);

      var def = self._proto, $scope = self._scope;

      def.page = nil;
      def.$initialize = function(page) {
        var $a, $b, self = this, that = nil;

        self.page = page;
        if ((($a = (($b = $scope.Volt) == null ? $opal.cm('Volt') : $b)['$client?']()) !== nil && (!$a._isBoolean || $a == true))) {
          that = self;
          
          window.addEventListener("popstate", function(e) {
            that.$url_updated();
            return true;
          });
        
          } else {
          return nil
        };
      };

      return (def.$url_updated = function(first_call) {
        var self = this;

        if (first_call == null) {
          first_call = false
        }
        self.page.$url().$parse(document.location.href);
        if (first_call !== false && first_call !== nil) {
          return nil
          } else {
          return self.page.$url()['$update!']()
        };
      }, nil) && 'url_updated';
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $klass = $opal.klass;

  $opal.add_stubs(['$==', '$puts', '$times', '$<<', '$inspect']);
  if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
    return (function($base, $super) {
      function $Benchmark(){};
      var self = $Benchmark = $klass($base, $super, 'Benchmark', $Benchmark);

      var def = self._proto, $scope = self._scope, TMP_2;

      return ($opal.defs(self, '$bm', TMP_2 = function(iterations) {
        var $a, $b, TMP_1, self = this, $iter = TMP_2._p, $yield = $iter || nil, times = nil, total_time = nil, result = nil;

        if (iterations == null) {
          iterations = 1
        }
        TMP_2._p = null;
        self.$puts("BM");
        times = [];
        total_time = nil;
        result = nil;
        ($a = ($b = iterations).$times, $a._p = (TMP_1 = function(){var self = TMP_1._s || this, $a, start_time = nil, end_time = nil;

        start_time = Date.now();
          result = ((($a = $opal.$yieldX($yield, [])) === $breaker) ? $breaker.$v : $a);
          end_time = Date.now();
          total_time = end_time - start_time;
          return times['$<<'](total_time);}, TMP_1._s = self, TMP_1), $a).call($b);
        if (iterations['$=='](1)) {
          self.$puts("TOTAL TIME: " + (total_time) + "ms")
          } else {
          self.$puts("Times: " + (times.$inspect()))
        };
        return result;
      }), nil) && 'bm'
    })(self, null)}
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2, $gvars = $opal.gvars;

  $opal.add_stubs(['$on', '$received_message', '$channel', '$+', '$new', '$[]=', '$send_message', '$===', '$notify_query', '$response', '$reload', '$delete', '$puts', '$inspect', '$reject', '$resolve', '$lookup', '$query_pool', '$send', '$dump', '$to_h', '$page', '$_reloading=']);
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope;

    (function($base, $super) {
      function $Tasks(){};
      var self = $Tasks = $klass($base, $super, 'Tasks', $Tasks);

      var def = self._proto, $scope = self._scope;

      def.promise_id = def.promises = def.page = nil;
      def.$initialize = function(page) {
        var $a, $b, TMP_1, self = this;

        self.page = page;
        self.promise_id = 0;
        self.promises = $hash2([], {});
        return ($a = ($b = page.$channel()).$on, $a._p = (TMP_1 = function(args){var self = TMP_1._s || this, $a;
args = $slice.call(arguments, 0);
        return ($a = self).$received_message.apply($a, [].concat(args))}, TMP_1._s = self, TMP_1), $a).call($b, "message");
      };

      def.$call = function(class_name, method_name, meta_data, args) {
        var $a, self = this, promise_id = nil, promise = nil;

        args = $slice.call(arguments, 3);
        promise_id = self.promise_id;
        self.promise_id = self.promise_id['$+'](1);
        promise = (($a = $scope.Promise) == null ? $opal.cm('Promise') : $a).$new();
        self.promises['$[]='](promise_id, promise);
        self.page.$channel().$send_message([promise_id, class_name, method_name, meta_data].concat(args));
        return promise;
      };

      def.$received_message = function(name, promise_id, args) {
        var $a, $b, self = this, $case = nil;

        args = $slice.call(arguments, 2);
        return (function() {$case = name;if ("added"['$===']($case) || "removed"['$===']($case) || "updated"['$===']($case) || "changed"['$===']($case)) {return ($a = self).$notify_query.apply($a, [name].concat(args))}else if ("response"['$===']($case)) {return ($b = self).$response.apply($b, [promise_id].concat(args))}else if ("reload"['$===']($case)) {return self.$reload()}else { return nil }})();
      };

      def.$response = function(promise_id, result, error) {
        var self = this, promise = nil;

        promise = self.promises.$delete(promise_id);
        if (promise !== false && promise !== nil) {
          if (error !== false && error !== nil) {
            self.$puts("Task Response: " + (error.$inspect()));
            return promise.$reject(error);
            } else {
            return promise.$resolve(result)
          }
          } else {
          return nil
        };
      };

      def.$notify_query = function(method_name, collection, query, args) {
        var $a, $b, self = this, query_obj = nil;

        args = $slice.call(arguments, 3);
        query_obj = (($a = ((($b = $scope.Persistors) == null ? $opal.cm('Persistors') : $b))._scope).ArrayStore == null ? $a.cm('ArrayStore') : $a.ArrayStore).$query_pool().$lookup(collection, query);
        return ($a = query_obj).$send.apply($a, [method_name].concat(args));
      };

      return (def.$reload = function() {
        var $a, self = this, value = nil;
        if ($gvars.page == null) $gvars.page = nil;

        value = (($a = $scope.JSON) == null ? $opal.cm('JSON') : $a).$dump($gvars.page.$page().$to_h());
        if ((($a = sessionStorage) !== nil && (!$a._isBoolean || $a == true))) {
          sessionStorage.setItem('___page', value);};
        $gvars.page.$page()['$_reloading='](true);
        window.location.reload(false);
      }, nil) && 'reload';
    })(self, null)
    
  })(self)
})(Opal);
/* Generated by Opal 0.6.3 */
(function($opal) {
  var $a, self = $opal.top, $scope = $opal, nil = $opal.nil, $breaker = $opal.breaker, $slice = $opal.slice, $module = $opal.module, $klass = $opal.klass, $hash2 = $opal.hash2, $gvars = $opal.gvars;

  $opal.add_stubs(['$==', '$attr_reader', '$new', '$params', '$development?', '$env', '$tasks', '$client?', '$on', '$_reconnected=', '$channel', '$blank?', '$parse', '$clear', '$flash', '$puts', '$to_sym', '$camelize', '$[]=', '$const_get', '$raise', '$[]', '$define', '$to_proc', '$router=', '$html=', '$find', '$load_stored_page', '$url_updated', '$watch!', '$proc', '$gsub', '$html', '$each_pair', '$send', '$page', '$to_s', '$inspect', '$ready?', '$start']);
  if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
    ;
    ;};
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  ;
  if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
    };
  ;
  ;
  ;
  ;
  ;
  return (function($base) {
    var self = $module($base, 'Volt');

    var def = self._proto, $scope = self._scope, $a, $b, TMP_5, $c;

    (function($base, $super) {
      function $Page(){};
      var self = $Page = $klass($base, $super, 'Page', $Page);

      var def = self._proto, $scope = self._scope, TMP_2;

      def.url = def.flash = def.store = def.local_store = def.cookies = def.tasks = def.channel = def.model_classes = def.templates = def.routes = def.url_tracker = nil;
      self.$attr_reader("url", "params", "page", "templates", "routes", "events", "model_classes");

      def.$initialize = function() {
        var $a, $b, TMP_1, self = this;

        self.model_classes = $hash2([], {});
        self.page = (($a = $scope.Model) == null ? $opal.cm('Model') : $a).$new();
        self.url = (($a = $scope.URL) == null ? $opal.cm('URL') : $a).$new();
        self.params = self.url.$params();
        self.url_tracker = (($a = $scope.UrlTracker) == null ? $opal.cm('UrlTracker') : $a).$new(self);
        self.events = (($a = $scope.DocumentEvents) == null ? $opal.cm('DocumentEvents') : $a).$new();
        if ((($a = $scope.RUBY_PLATFORM) == null ? $opal.cm('RUBY_PLATFORM') : $a)['$==']("opal")) {
          
          $(document).keyup(function(e) {
            if (e.keyCode == 27) {
              Opal.gvars.page.$launch_console();
            }
          });

          $(document).on('click', 'a', function(event) {
            return Opal.gvars.page.$link_clicked($(this).attr('href'), event);
          });
        };
        if ((($a = (($b = $scope.Volt) == null ? $opal.cm('Volt') : $b).$env()['$development?']()) !== nil && (!$a._isBoolean || $a == true))) {
          self.$tasks()};
        if ((($a = (($b = $scope.Volt) == null ? $opal.cm('Volt') : $b)['$client?']()) !== nil && (!$a._isBoolean || $a == true))) {
          return ($a = ($b = self.$channel()).$on, $a._p = (TMP_1 = function(){var self = TMP_1._s || this;
            if (self.page == null) self.page = nil;

          self.page['$_reconnected='](true);
            setTimeout(function() {;
            self.page['$_reconnected='](false);
            }, 2000);}, TMP_1._s = self, TMP_1), $a).call($b, "reconnected")
          } else {
          return nil
        };
      };

      def.$flash = function() {
        var $a, $b, $c, self = this;

        return ((($a = self.flash) !== false && $a !== nil) ? $a : self.flash = (($b = $scope.Model) == null ? $opal.cm('Model') : $b).$new($hash2([], {}), $hash2(["persistor"], {"persistor": (($b = ((($c = $scope.Persistors) == null ? $opal.cm('Persistors') : $c))._scope).Flash == null ? $b.cm('Flash') : $b.Flash)})));
      };

      def.$store = function() {
        var $a, $b, $c, self = this;

        return ((($a = self.store) !== false && $a !== nil) ? $a : self.store = (($b = $scope.Model) == null ? $opal.cm('Model') : $b).$new($hash2([], {}), $hash2(["persistor"], {"persistor": (($b = ((($c = $scope.Persistors) == null ? $opal.cm('Persistors') : $c))._scope).StoreFactory == null ? $b.cm('StoreFactory') : $b.StoreFactory).$new(self.$tasks())})));
      };

      def.$local_store = function() {
        var $a, $b, $c, self = this;

        return ((($a = self.local_store) !== false && $a !== nil) ? $a : self.local_store = (($b = $scope.Model) == null ? $opal.cm('Model') : $b).$new($hash2([], {}), $hash2(["persistor"], {"persistor": (($b = ((($c = $scope.Persistors) == null ? $opal.cm('Persistors') : $c))._scope).LocalStore == null ? $b.cm('LocalStore') : $b.LocalStore)})));
      };

      def.$cookies = function() {
        var $a, $b, $c, self = this;

        return ((($a = self.cookies) !== false && $a !== nil) ? $a : self.cookies = (($b = $scope.Model) == null ? $opal.cm('Model') : $b).$new($hash2([], {}), $hash2(["persistor"], {"persistor": (($b = ((($c = $scope.Persistors) == null ? $opal.cm('Persistors') : $c))._scope).Cookies == null ? $b.cm('Cookies') : $b.Cookies)})));
      };

      def.$tasks = function() {
        var $a, $b, self = this;

        return ((($a = self.tasks) !== false && $a !== nil) ? $a : self.tasks = (($b = $scope.Tasks) == null ? $opal.cm('Tasks') : $b).$new(self));
      };

      def.$link_clicked = function(url, event) {
        var $a, self = this;

        if (url == null) {
          url = ""
        }
        if (event == null) {
          event = nil
        }
        if ((($a = url['$blank?']()) !== nil && (!$a._isBoolean || $a == true))) {
          return false};
        if ((($a = self.url.$parse(url)) !== nil && (!$a._isBoolean || $a == true))) {
          if (event !== false && event !== nil) {
            event.stopPropagation();};
          self.$flash().$clear();
          return false;};
        return true;
      };

      def.$binding_name = function() {
        var self = this;

        return "page";
      };

      def.$launch_console = function() {
        var self = this;

        return self.$puts("Launch Console");
      };

      def.$channel = function() {
        var $a, $b, $c, self = this;

        return ((($a = self.channel) !== false && $a !== nil) ? $a : self.channel = (function() {if ((($b = (($c = $scope.Volt) == null ? $opal.cm('Volt') : $c)['$client?']()) !== nil && (!$b._isBoolean || $b == true))) {
          return (($b = $scope.Channel) == null ? $opal.cm('Channel') : $b).$new()
          } else {
          return (($b = $scope.ChannelStub) == null ? $opal.cm('ChannelStub') : $b).$new()
        }; return nil; })());
      };

      self.$attr_reader("events");

      def.$add_model = function(model_name) {
        var $a, self = this, e = nil;

        try {
        model_name = model_name.$camelize().$to_sym();
          return self.model_classes['$[]='](model_name, (($a = $scope.Object) == null ? $opal.cm('Object') : $a).$const_get(model_name));
        } catch ($err) {if ($opal.$rescue($err, [(($a = $scope.NameError) == null ? $opal.cm('NameError') : $a)])) {e = $err;
          if (model_name['$==']("User")) {
            return nil
            } else {
            return self.$raise()
          }
          }else { throw $err; }
        };
      };

      def.$add_template = function(name, template, bindings) {
        var $a, self = this;

        ((($a = self.templates) !== false && $a !== nil) ? $a : self.templates = $hash2([], {}));
        if ((($a = self.templates['$[]'](name)) !== nil && (!$a._isBoolean || $a == true))) {
          return nil
          } else {
          return self.templates['$[]='](name, $hash2(["html", "bindings"], {"html": template, "bindings": bindings}))
        };
      };

      def.$add_routes = TMP_2 = function() {
        var $a, $b, self = this, $iter = TMP_2._p, block = $iter || nil;

        TMP_2._p = null;
        ((($a = self.routes) !== false && $a !== nil) ? $a : self.routes = (($b = $scope.Routes) == null ? $opal.cm('Routes') : $b).$new());
        ($a = ($b = self.routes).$define, $a._p = block.$to_proc(), $a).call($b);
        return self.url['$router='](self.routes);
      };

      def.$start = function() {
        var $a, $b, TMP_3, self = this, main_controller = nil;

        (($a = $scope.Element) == null ? $opal.cm('Element') : $a).$find("body")['$html=']("<!-- $CONTENT --><!-- $/CONTENT -->");
        self.$load_stored_page();
        self.url_tracker.$url_updated(true);
        main_controller = (($a = $scope.MainController) == null ? $opal.cm('MainController') : $a).$new();
        (($a = $scope.TemplateRenderer) == null ? $opal.cm('TemplateRenderer') : $a).$new(self, (($a = $scope.DomTarget) == null ? $opal.cm('DomTarget') : $a).$new(), main_controller, "CONTENT", "main/main/main/body");
        self.title_template = (($a = $scope.StringTemplateRender) == null ? $opal.cm('StringTemplateRender') : $a).$new(self, main_controller, "main/main/main/title");
        return ($a = ($b = self).$proc, $a._p = (TMP_3 = function(){var self = TMP_3._s || this, title = nil;
          if (self.title_template == null) self.title_template = nil;

        title = self.title_template.$html().$gsub(/\n/, " ");
          document.title = title;}, TMP_3._s = self, TMP_3), $a).call($b)['$watch!']();
      };

      return (def.$load_stored_page = function() {
        var $a, $b, TMP_4, $c, self = this, page_obj_str = nil, e = nil;

        try {
        if ((($a = (($b = $scope.Volt) == null ? $opal.cm('Volt') : $b)['$client?']()) !== nil && (!$a._isBoolean || $a == true))) {
            if ((($a = sessionStorage) !== nil && (!$a._isBoolean || $a == true))) {
              page_obj_str = nil;
              page_obj_str = sessionStorage.getItem('___page');
              if (page_obj_str) {;
              sessionStorage.removeItem('___page');
              ($a = ($b = (($c = $scope.JSON) == null ? $opal.cm('JSON') : $c).$parse(page_obj_str)).$each_pair, $a._p = (TMP_4 = function(key, value){var self = TMP_4._s || this;
if (key == null) key = nil;if (value == null) value = nil;
              return self.$page().$send(("_" + key.$to_s() + "="), value)}, TMP_4._s = self, TMP_4), $a).call($b);
              return };
              } else {
              return nil
            }
            } else {
            return nil
          }
        } catch ($err) {if (true) {e = $err;
          return self.$puts("Unable to restore: " + (e.$inspect()))
          }else { throw $err; }
        };
      }, nil) && 'load_stored_page';
    })(self, null);

    if ((($a = (($b = $scope.Volt) == null ? $opal.cm('Volt') : $b)['$client?']()) !== nil && (!$a._isBoolean || $a == true))) {
      $gvars.page = (($a = $scope.Page) == null ? $opal.cm('Page') : $a).$new();

      ($a = ($b = (($c = $scope.Document) == null ? $opal.cm('Document') : $c))['$ready?'], $a._p = (TMP_5 = function(){var self = TMP_5._s || this;
        if ($gvars.page == null) $gvars.page = nil;

      return $gvars.page.$start()}, TMP_5._s = self, TMP_5), $a).call($b);};
    
  })(self);
})(Opal);
