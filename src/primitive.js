(function($, $$) {

var _ = Wysie.Primitive = $.Class({
	extends: Wysie.Unit,
	constructor: function (element, wysie, o) {
		if (this.template) {
			$.extend(this, this.template, ["attribute", "datatype"]);
		}
		else {
			// Which attribute holds the data, if any?
			// "null" or null for none (i.e. data is in content).
			this.attribute = _.getValueAttribute(this.element);

			if (!this.attribute) {
				this.element.normalize();
			}

			this.datatype = _.getDatatype(this.element, this.attribute);
		}

		// Primitives containing an expression as their value are implicitly computed
		var expressions = Wysie.Expression.Text.elements.get(this.element);
		var expressionText = expressions && expressions.filter(e => e.attribute == this.attribute)[0];

		if (expressionText) {
			expressionText.primitive = this;
			this.computed = true;
		}

		/**
		 * Set up input widget
		 */

		// Exposed widgets (visible always)
		if (Wysie.is("formControl", this.element)) {
			this.editor = this.element;

			this.edit();
		}
		// Nested widgets
		else if (!this.editor) {

			this.editor = $$(this.element.children).filter(function (el) {
			    return el.matches(Wysie.selectors.formControl) && !el.matches(Wysie.selectors.property);
			})[0];

			$.remove(this.editor);
		}

		if (!this.exposed && !this.computed) {
			this.wysie.needsEdit = true;
		}

		this.default = this.element.getAttribute("data-default");

		// Observe future mutations to this property, if possible
		// Properties like input.checked or input.value cannot be observed that way
		// so we cannot depend on mutation observers for everything :(
		this.observer = Wysie.observe(this.element, this.attribute, record => {
			if (this.attribute || !this.wysie.editing || this.computed) {
				this.value = this.getValue();
			}
		}, true);

		this.templateValue = this.getValue();

		if (this.computed || this.default === "") { // attribute exists, no value, default is template value
			this.default = this.templateValue;
		}
		else {
			if (this.default === null) { // attribute does not exist
				this.default = this.editor? this.editorValue : this.emptyValue;
			}

			this.value = this.default;
		}

		if (this.collection) {
			// Collection of primitives, deal with setting textContent etc without the UI interfering.
			var swapUI = callback => {
				this.unobserve();
				var ui = $.remove($(Wysie.selectors.ui, this.element));

				var ret = callback();

				$.inside(ui, this.element);
				this.observe();

				return ret;
			};

			// Intercept certain properties so that any Wysie UI inside this primitive will not be destroyed
			["textContent", "innerHTML"].forEach(property => {
				var descriptor = Object.getOwnPropertyDescriptor(Node.prototype, property);

				Object.defineProperty(this.element, property, {
					get: function() {
						return swapUI(() => descriptor.get.call(this));
					},

					set: function(value) {
						swapUI(() => descriptor.set.call(this, value));
					}
				});
			});
		}

		this.initialized = true;

		this.value = this.getValue();
	},

	get editorValue() {
		if (this.editor) {
			if (this.editor.matches(Wysie.selectors.formControl)) {
				return _.getValue(this.editor, undefined, this.datatype);
			}

			// if we're here, this.editor is an entire HTML structure
			var output = $(Wysie.selectors.output + ", " + Wysie.selectors.formControl, this.editor);

			if (output) {
				return _.all.has(output)? _.all.get(output).value : _.getValue(output);
			}
		}
	},

	set editorValue(value) {
		if (this.editor) {
			if (this.editor.matches(Wysie.selectors.formControl)) {
				_.setValue(this.editor, value);
			}
			else {
				// if we're here, this.editor is an entire HTML structure
				var output = $(Wysie.selectors.output + ", " + Wysie.selectors.formControl, this.editor);

				if (output) {
					if (_.all.has(output)) {
						_.all.get(output).value = value;
					}
					else {
						_.setValue(output, value);
					}
				}
			}
		}
	},

	get exposed() {
		return this.editor === this.element;
	},

	getData: function(o) {
		o = o || {};

		var ret = this.super.getData.call(this, o);

		if (ret !== undefined) {
			return ret;
		}

		var ret = !o.dirty && !this.exposed? this.savedValue : this.value;

		if (!o.dirty && ret === "") {
			return null;
		}

		return ret;
	},

	update: function () {
		var value = _.getValue(this.element, this.attribute, this.datatype);
		value = value || value === 0? value : "";

		if (value == this.oldValue) {
			return false;
		}

		this.value = value;

		this.empty = value === "";

		if (this.humanReadable && this.attribute) {
			this.element.textContent = this.humanReadable(value);
		}

		if (this.initialized) {
			$.fire(this.element, "wysie:datachange", {
				property: this.property,
				value: value,
				wysie: this.wysie,
				node: this,
				dirty: this.editing,
				action: "propertychange"
			});
		}
	},

	save: function() {
		if (this.placeholder) {
			return false;
		}

		this.savedValue = this.value;
		this.everSaved = true;
		this.unsavedChanges = false;
	},

	done: function () {
		this.unobserve();

		if (this.popup) {
			this.hidePopup();
		}
		else if (!this.attribute && !this.exposed && this.editing) {
			$.remove(this.editor);
			this.element.textContent = this.editorValue;
		}

		if (!this.exposed) {
			this.editing = false;
		}

		// Revert tabIndex
		if (this.element._.data.prevTabindex !== null) {
			this.element.tabIndex = this.element._.data.prevTabindex;
		}
		else {
			this.element.removeAttribute("tabindex");
		}

		this.element._.unbind(".wysie:edit .wysie:preedit .wysie:showpopup");

		this.observe();
	},

	revert: function() {
		if (this.unsavedChanges && this.savedValue !== undefined) {
			// FIXME if we have a collection of properties (not scopes), this will cause
			// cancel to not remove new unsaved items
			// This should be fixed by handling this on the collection level.
			this.value = this.savedValue;
			this.unsavedChanges = false;
		}
	},

	// Prepare to be edited
	// Called when root edit button is pressed
	preEdit: function () {
		if (this.computed) {
			return;
		}

		// Empty properties should become editable immediately
		// otherwise they could be invisible!
		if (this.empty && !this.attribute) {
			this.edit();
			return;
		}

		var timer;

		this.element._.events({
			// click is needed too because it works with the keyboard as well
			"click.wysie:preedit": e => this.edit(),
			"focus.wysie:preedit": e => {
				this.edit();

				if (!this.popup) {
					this.editor.focus();
				}
			},
			"click.wysie:edit": evt => {
				// Prevent default actions while editing
				// e.g. following links etc
				if (!this.exposed) {
					evt.preventDefault();
				}
			}
		});

		if (!this.attribute) {
			this.element._.events({
				"mouseenter.wysie:preedit": e => {
					clearTimeout(timer);
					timer = setTimeout(() => this.edit(), 150);
				},
				"mouseleave.wysie:preedit": e => {
					clearTimeout(timer);
				}
			});
		}

		// Make element focusable, so it can actually receive focus
		this.element._.data.prevTabindex = this.element.getAttribute("tabindex");
		this.element.tabIndex = 0;
	},

	// Called only the first time this primitive is edited
	initEdit: function () {
		// Linked widgets
		if (this.element.hasAttribute("data-input")) {
			var selector = this.element.getAttribute("data-input");

			if (selector) {
				this.editor = $.clone($(selector));

				if (!Wysie.is("formControl", this.editor)) {
					if ($(Wysie.selectors.output, this.editor)) { // has output element?
						// Process it as a wysie instance, so people can use references
						this.editor.setAttribute("data-store", "none");
						new Wysie(this.editor);
					}
					else {
						this.editor = null; // Cannot use this, sorry bro
					}
				}
			}
		}

		if (!this.editor) {
			// No editor provided, use default for element type
			// Find default editor for datatype
			var editor = _.getMatch(this.element, _.editors);

			if (editor.create) {
				$.extend(this, editor, property => property != "create");
			}

			var create = editor.create || editor;
			this.editor = $.create($.type(create) === "function"? create.call(this) : create);
			this.editorValue = this.value;
		}

		this.editor._.events({
			"input change": evt => {
				var unsavedChanges = this.wysie.unsavedChanges;

				this.value = this.editorValue;

				// Editing exposed elements outside edit mode is instantly saved
				if (
					this.exposed &&
					!this.wysie.editing && // must not be in edit mode
				    this.wysie.permissions.save && // must be able to save
				    this.scope.everSaved // must not cause unsaved items to be saved
				) {
					// TODO what if change event never fires? What if user
					this.unsavedChanges = false;
					this.wysie.unsavedChanges = unsavedChanges;

					// Must not save too many times (e.g. not while dragging a slider)
					if (evt.type == "change") {
						this.save(); // Save current element

						// Don’t call this.wysie.save() as it will save other fields too
						// We only want to save exposed controls, so save current status
						this.wysie.storage.save();

						// Are there any unsaved changes from other properties?
						this.wysie.unsavedChanges = this.wysie.calculateUnsavedChanges();
					}
				}
			},
			"focus": evt => {
				this.editor.select && this.editor.select();
			},
			"keyup": evt => {
				if (this.popup && evt.keyCode == 13 || evt.keyCode == 27) {
					if (this.popup.contains(document.activeElement)) {
						this.element.focus();
					}

					evt.stopPropagation();
					this.hidePopup();
				}
			},
			"wysie:datachange": evt => {
				if (evt.property === "output") {
					evt.stopPropagation();
					$.fire(this.editor, "input");
				}
			}
		});

		if ("placeholder" in this.editor) {
			this.editor.placeholder = "(" + this.label + ")";
		}

		if (!this.exposed) {
			// Copy any data-input-* attributes from the element to the editor
			var dataInput = /^data-input-/i;
			$$(this.element.attributes).forEach(function (attribute) {
				if (dataInput.test(attribute.name)) {
					this.editor.setAttribute(attribute.name.replace(dataInput, ""), attribute.value);
				}
			}, this);

			if (this.attribute) {
				// Set up popup
				this.element.classList.add("using-popup");

				this.popup = this.popup || $.create("div", {
					className: "wysie-popup",
					hidden: true,
					contents: [
						this.label + ":",
						this.editor
					]
				});

				// No point in having a dropdown in a popup
				if (this.editor.matches("select")) {
					this.editor.size = Math.min(10, this.editor.children.length);
				}

				// Toggle popup events & methods
				var hideCallback = evt => {
					if (!this.popup.contains(evt.target) && !this.element.contains(evt.target)) {
						this.hidePopup();
					}
				};

				this.showPopup = function() {
					$.unbind([this.element, this.popup], ".wysie:showpopup");
					this.popup._.after(this.element);

					var x = this.element.offsetLeft;
					var y = this.element.offsetTop + this.element.offsetHeight;

					 // TODO what if it doesn’t fit?
					this.popup._.style({ top:  `${y}px`, left: `${x}px` });

					this.popup._.removeAttribute("hidden"); // trigger transition

					$.events(document, "focus click", hideCallback, true);
				};

				this.hidePopup = function() {
					$.unbind(document, "focus click", hideCallback, true);

					this.popup.setAttribute("hidden", ""); // trigger transition

					setTimeout(() => {
						$.remove(this.popup);
					}, 400); // TODO transition-duration could override this

					$.events(this.element, "focus.wysie:showpopup click.wysie:showpopup", evt => {
						this.showPopup();
					}, true);
				};
			}
		}

		if (!this.popup) {
			this.editor.classList.add("wysie-editor");
		}

		this.initEdit = null;
	},

	edit: function () {
		if (this.computed || this.editing) {
			return;
		}

		this.element._.unbind(".wysie:preedit");

		if (this.initEdit) {
			this.initEdit();
		}

		if (this.popup) {
			this.showPopup();
		}

		if (!this.attribute) {
			if (this.editor.parentNode != this.element && !this.exposed) {
				this.editorValue = this.value;
				this.element.textContent = "";

				if (!this.exposed) {
					this.element.appendChild(this.editor);
				}
			}
		}

		this.editing = true;
	}, // edit

	clear: function() {
		this.value = this.emptyValue;
	},

	import: function() {
		if (!this.computed) {
			this.value = this.templateValue;
		}
	},

	render: function(data) {
		if (Array.isArray(data)) {
			data = data[0]; // TODO what is gonna happen to the rest? Lost?
		}

		if (typeof data === "object") {
			data = data[this.property];
		}

		this.value = data === undefined? this.default : data;

		this.save();
	},

	find: function(property) {
		if (this.property == property) {
			return this;
		}
	},

	observe: function() {
		Wysie.observe(this.element, this.attribute, this.observer);
	},

	unobserve: function () {
		this.observer.disconnect();
	},

	getValue: function() {
		return _.getValue(this.element, this.attribute, this.datatype);
	},

	lazy: {
		label: function() {
			return Wysie.readable(this.property);
		},

		emptyValue: function() {
			switch (this.datatype) {
				case "boolean":
					return false;
				case "number":
					return 0;
			}

			return "";
		}
	},

	live: {
		value: {
			get: function() {
				// if (this.editing) {
				// 	var ret = this.editorValue;
				//
				// 	return ret === ""? null : ret;
				// }
			},

			set: function (value) {
				value = value || value === 0? value : "";
				value = _.cast(value, this.datatype);

				if (value == this._value) {
					return;
				}

				if (this.editor) {
					this.editorValue = value;
				}

				if (!this.editing || this.attribute) {
					if (this.datatype == "number" && !this.attribute) {
						_.setValue(this.element, value, "content", this.datatype);
						_.setValue(this.element, Wysie.Expression.Text.formatNumber(value), null, this.datatype);
					}
					else if (this.editor && this.editor.matches("select")) {
						this.editorValue = value;
						_.setValue(this.element, value, "content", this.datatype);
						_.setValue(this.element, this.editor.selectedOptions[0]? this.editor.selectedOptions[0].textContent : value, this.attribute, this.datatype);
					}
					else {
						_.setValue(this.element, value, this.attribute, this.datatype);
					}
				}

				this.empty = value === "";

				if (this.humanReadable && this.attribute) {
					this.element.textContent = this.humanReadable(value);
				}

				this._value = value;

				this.unsavedChanges = this.wysie.unsavedChanges = true;

				$.fire(this.element, "wysie:datachange", {
					property: this.property,
					value: value,
					wysie: this.wysie,
					node: this,
					dirty: this.editing,
					action: "propertychange"
				});

				this.oldValue = this.value;

				return value;
			}
		},

		empty: function(value) {
			var hide = value && !this.exposed && !(this.attribute && $(Wysie.selectors.property, this.element));
			this.element.classList.toggle("empty", hide);
		},

		editing: function (value) {
			this.element.classList.toggle("editing", value);
		},

		computed: function (value) {
			this.element.classList.toggle("computed", value);
		},

		datatype: function (value) {
			// Purge caches if datatype changes
			if (_.getValue.cache) {
				_.getValue.cache.delete(this.element);
			}
		}
	},

	static: {
		all: new WeakMap(),

		getMatch: function (element, all) {
			// TODO specificity
			var ret = null;

			for (var selector in all) {
				if (element.matches(selector)) {
					ret = all[selector];
				}
			}

			return ret;
		},

		getValueAttribute: function (element) {
			var ret = element.getAttribute("data-attribute") || _.getMatch(element, _.attributes);

			// TODO refactor this
			if (ret) {
				if (ret.humanReadable && _.all.has(element)) {
					_.all.get(element).humanReadable = ret.humanReadable;
				}

				ret = ret.value || ret;
			}

			if (!ret || ret === "null") {
				ret = null;
			}

			return ret;
		},

		getDatatype: function (element, attribute) {
			var ret = element.getAttribute("datatype");

			if (!ret) {
				for (var selector in _.datatypes) {
					if (element.matches(selector)) {
						ret = _.datatypes[selector][attribute];
					}
				}
			}

			ret = ret || "string";

			return ret;
		},

		cast: function(value, datatype) {
			if (datatype == "number") {
				return +value;
			}

			if (datatype == "boolean") {
				return !!value;
			}

			return value;
		},

		getValue: function (element, attribute, datatype) {
				attribute = attribute || attribute === null? attribute : _.getValueAttribute(element);
				datatype = datatype || _.getDatatype(element, attribute);

				var ret;

				if (attribute in element && _.useProperty(element, attribute)) {
					// Returning properties (if they exist) instead of attributes
					// is needed for dynamic elements such as checkboxes, sliders etc
					ret = element[attribute];
				}
				else if (attribute) {
					ret = element.getAttribute(attribute);
				}
				else {
					ret = element.getAttribute("content") || element.textContent || null;
				}

				return _.cast(ret, datatype);
		},

		setValue: function (element, value, attribute) {
			if (attribute !== null) {
				attribute = attribute ||  _.getValueAttribute(element);
			}

			if (attribute in element && _.useProperty(element, attribute) && element[attribute] != value) {
				// Setting properties (if they exist) instead of attributes
				// is needed for dynamic elements such as checkboxes, sliders etc
				try {
					element[attribute] = value;
				}
				catch (e) {}
			}

			// Set attribute anyway, even if we set a property because when
			// they're not in sync it gets really fucking confusing.
			if (attribute) {
				if (element.getAttribute(attribute) != value) { // intentionally non-strict, e.g. "3." !== 3
					element.setAttribute(attribute, value);
				}
			}
			else {
				element.textContent = value;
			}
		},

		/**
		 *  Set/get a property or an attribute?
		 * @return {Boolean} true to use a property, false to use the attribute
		 */
		useProperty: function(element, attribute) {
			if (["href", "src"].indexOf(attribute) > -1) {
				// URL properties resolve "" as location.href, fucking up emptiness checks
				return false;
			}

			if (element.namespaceURI == "http://www.w3.org/2000/svg") {
				// SVG has a fucked up DOM, do not use these properties
				return false;
			}

			return true;
		}
	}
});

// Define default attributes
_.attributes = {
	"img, video, audio": "src",
	"a, link": "href",
	"select, input, textarea, meter, progress": "value",
	"input[type=checkbox]": "checked",
	"time": {
		value: "datetime",
		humanReadable: function (value) {
			var date = new Date(value);

			if (!value || isNaN(date)) {
				return "(No " + this.label + ")";
			}

			// TODO do this properly (account for other datetime datatypes and different formats)
			var options = {
				"date": {day: "numeric", month: "short", year: "numeric"},
				"month": {month: "long"},
				"time": {hour: "numeric", minute: "numeric"},
				"datetime-local": {day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "numeric"}
			};

			var format = options[this.editor && this.editor.type] || options.date;
			format.timeZone = "UTC";

			return date.toLocaleString("en-GB", format);
		}
	},
	"meta": "content"
};

// Basic datatypes per attribute
// Only number, boolean
_.datatypes = {
	"input[type=checkbox]": {
		"checked": "boolean"
	},
	"input[type=range], input[type=number], meter, progress": {
		"value": "number"
	}
};

_.editors = {
	"*": {"tag": "input"},

	".number": {
		"tag": "input",
		"type": "number"
	},

	".boolean": {
		"tag": "input",
		"type": "checkbox"
	},

	"a, img, video, audio, .url": {
		"tag": "input",
		"type": "url",
		"placeholder": "http://"
	},

	// Block elements
	"p, div, li, dt, dd, h1, h2, h3, h4, h5, h6, article, section, .multiline": {
		create: function() {
			var display = getComputedStyle(this.element).display;
			var tag = display.indexOf("inline") === 0? "input" : "textarea";
			var editor = $.create(tag);

			if (tag == "textarea") {
				var width = this.element.offsetWidth;

				if (width) {
					editor.width = width;
				}
			}

			return editor;
		},

		get editorValue () {
			return this.editor && _.cast(this.editor.value, this.datatype);
		},

		set editorValue (value) {
			if (this.editor) {
				this.editor.value = value ? value.replace(/\r?\n/g, "") : "";
			}
		}
	},

	"meter, progress": function() {
		return $.create({
			tag: "input",
			type: "range",
			min: this.element.getAttribute("min") || 0,
			max: this.element.getAttribute("max") || 100
		});
	},

	"time, .date": function() {
		var types = {
			"date": /^[Y\d]{4}-[M\d]{2}-[D\d]{2}$/i,
			"month": /^[Y\d]{4}-[M\d]{2}$/i,
			"time": /^[H\d]{2}:[M\d]{2}/i,
			"week": /[Y\d]{4}-W[W\d]{2}$/i,
			"datetime-local": /^[Y\d]{4}-[M\d]{2}-[D\d]{2} [H\d]{2}:[M\d]{2}/i
		};

		var datetime = this.element.getAttribute("datetime") || "YYYY-MM-DD";

		for (var type in types) {
			if (types[type].test(datetime)) {
				break;
			}
		}

		return $.create("input", {type: type});
	}
};

})(Bliss, Bliss.$);
