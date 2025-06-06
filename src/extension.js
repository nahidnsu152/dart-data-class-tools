
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

var projectName = '';
var isFlutter = false;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'dart_data_class.generate.from_props',
            generateDataClass
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'dart_data_class.generate.from_json',
            generateJsonDataClass
        )
    );

    context.subscriptions.push(vscode.languages.registerCodeActionsProvider({
        language: 'dart',
        scheme: 'file'
    }, new DataClassCodeActions(), {
        providedCodeActionKinds: [
            vscode.CodeActionKind.QuickFix
        ],
    }));

    findProjectName();
}

async function findProjectName() {
    const pubspecs = await vscode.workspace.findFiles('pubspec.yaml');

    if (pubspecs != null && pubspecs.length > 0) {
        const pubspec = pubspecs[0];
        const content = fs.readFileSync(pubspec.fsPath, 'utf8');

        if (content != null && content.includes('name: ')) {
            isFlutter = content.includes('flutter:') && content.includes('sdk: flutter');

            for (const line of content.split('\n')) {
                if (line.startsWith('name: ')) {
                    projectName = line.replace('name:', '').trim();
                    break;
                }
            }
        }
    }
}

async function generateJsonDataClass() {
    let langId = getLangId();

    if (langId == 'dart') {
        let document = getDocText();

        const name = await vscode.window.showInputBox({
            placeHolder: 'Please type in a class name.'
        });

        if (name == null || name.length == 0) {
            return;
        }

        let reader = new JsonReader(document, name);
        let separate = true;

        if (await reader.error == null) {
            if (reader.files.length >= 2) {
                const setting = readSetting('json.separate');

                if (setting == 'ask') {
                    const r = await vscode.window.showQuickPick(['Yes', 'No'], {
                        canPickMany: false,
                        placeHolder: 'Do you wish to separate the JSON into multiple files?'
                    });

                    if (r != null) {
                        separate = r == 'Yes';
                    } else {
                        return;
                    }
                } else {
                    separate = setting == 'separate';
                }
            }

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                cancellable: false
            }, async function (progress, token) {
                progress.report({ increment: 0, message: 'Generating Data Classes...' });
                scrollTo(0);

                await reader.commitJson(progress, separate);

                clearSelection();
            });
        } else {
            showError(await reader.error);
        }
    } else if (langId == 'json') {
        showError('Please paste the JSON directly into an empty .dart file and then try again!');
    } else {
        showError('Make sure that you\'re editing a dart file and then try again!');
    }
}

async function generateDataClass(text = getDocText()) {
    if (getLangId() == 'dart') {
        const generator = new DataClassGenerator(text);
        let clazzes = generator.clazzes;

        if (clazzes.length == 0) {
            showError('No convertable dart classes were detected!');
            return null;
        } else if (clazzes.length >= 2) {
            clazzes = await showClassChooser(clazzes);

            if (clazzes == null) {
                showInfo('No classes selected!');
                return;
            }
        }

        for (let clazz of clazzes) {
            if (clazz.isValid && clazz.toReplace.length > 0) {
                if (readSetting('override.manual')) {
                    let result = [];

                    for (let replacement of clazz.toReplace) {
                        const r = await vscode.window.showQuickPick(['Yes', 'No'], {
                            placeHolder: `Do you want to override ${replacement.name}?`,
                            canPickMany: false
                        });

                        if (r == null) {
                            showInfo('Canceled!');
                            return;
                        } else if ('Yes' == r) result.push(replacement);
                    }
                    clazz.toReplace = result;
                }
            }
        }

        console.log(clazzes);

        const edit = getReplaceEdit(clazzes, generator.imports, true);
        await vscode.workspace.applyEdit(edit);

        clearSelection();

        return clazzes;
    } else {
        showError('Make sure that you\'re editing a dart file and then try again!');
        return null;
    }
}

/**
 * @param {DartClass[]} clazzez
 */
async function showClassChooser(clazzez) {
    const values = clazzez.map((v) => v.name);

    const r = await vscode.window.showQuickPick(values, {
        placeHolder: 'Please select the classes you want to generate data classes of.',
        canPickMany: true,
    });

    let result = [];

    if (r != null && r.length > 0) {
        for (let c of r) {
            for (let clazz of clazzez) {
                if (clazz.name == c)
                    result.push(clazz);
            }
        }
    } else return null;

    return result;
}

class DartClass {
    constructor() {
        this.name = null;
        this.fullGenericType = '';
        this.superclass = null;
        this.interfaces = [];
        this.mixins = [];
        this.constr = null;
        this.properties = [];
        this.startsAtLine = null;
        this.endsAtLine = null;
        this.constrStartsAtLine = null;
        this.constrEndsAtLine = null;
        this.constrDifferent = false;
        this.isArray = false;
        this.classContent = '';
        this.toInsert = '';
        this.toReplace = [];
        this.isLastInFile = false;
    }

    get type() {
        return this.name + this.genericType;
    }

    get genericType() {
        const parts = this.fullGenericType.split(',');

        return parts.map((type) => {
            let part = type.trim();

            if (part.includes('extends')) {
                part = part.substring(0, part.indexOf('extends')).trim();
                if (type === parts[parts.length - 1]) {
                    part += '>';
                }
            }

            return part;
        }).join(', ');
    }

    get propsEndAtLine() {
        if (this.properties.length > 0) {
            return this.properties[this.properties.length - 1].line;
        } else {
            return -1;
        }
    }

    get hasSuperclass() {
        return this.superclass != null;
    }

    get classDetected() {
        return this.startsAtLine != null;
    }

    get didChange() {
        return this.toInsert.length > 0 || this.toReplace.length > 0 || this.constrDifferent;
    }

    get hasNamedConstructor() {
        if (this.constr != null) {
            return this.constr.replace('const', '').trimLeft().startsWith(this.name + '({');
        }
        return true;
    }

    get hasConstructor() {
        return this.constrStartsAtLine != null && this.constrEndsAtLine != null && this.constr != null;
    }

    get hasMixins() {
        return this.mixins != null && this.mixins.length > 0;
    }

    get hasInterfaces() {
        return this.interfaces != null && this.interfaces.length > 0;
    }

    get hasEnding() {
        return this.endsAtLine != null;
    }

    get hasProperties() {
        return this.properties.length > 0;
    }

    get fewProps() {
        return this.properties.length <= 3;
    }

    get isValid() {
        return this.classDetected && this.hasEnding && this.hasProperties && this.uniquePropNames;
    }

    get isWidget() {
        return this.superclass != null && (this.superclass == 'StatelessWidget' || this.superclass == 'StatefulWidget');
    }

    get isStatelessWidget() {
        return this.isWidget && this.superclass != null && this.superclass == 'StatelessWidget';
    }

    get isState() {
        return !this.isWidget && this.superclass != null && this.superclass.startsWith('State<');
    }

    get isAbstract() {
        return this.classContent.trimLeft().startsWith('abstract class');
    }

    get usesEquatable() {
        return (this.hasSuperclass && this.superclass == 'Equatable') || (this.hasMixins && this.mixins.includes('EquatableMixin'));
    }

    get issue() {
        const def = this.name + ' couldn\'t be converted to a data class: ';
        let msg = def;

        if (!this.hasProperties) {
            msg += 'Class must have at least one property!';
        } else if (!this.hasEnding) {
            msg += 'Class has no ending!';
        } else if (!this.uniquePropNames) {
            msg += 'Class doesn\'t have unique property names!';
        } else {
            msg = removeEnd(msg, ': ') + '.';
        }

        return msg;
    }

    get uniquePropNames() {
        let props = [];

        for (let p of this.properties) {
            const n = p.name;

            if (props.includes(n))
                return false;

            props.push(n);
        }

        return true;
    }

    /**
     * @param {number} line
     */
    replacementAtLine(line) {
        for (let part of this.toReplace) {
            if (part.startsAt <= line && part.endsAt >= line) {
                return part.replacement;
            }
        }

        return null;
    }

    generateClassReplacement() {
        let replacement = '';
        let lines = this.classContent.split('\n');

        for (let i = this.endsAtLine - this.startsAtLine; i >= 0; i--) {
            let line = lines[i] + '\n';
            let l = this.startsAtLine + i;

            if (i == 0) {
                const classType = this.isAbstract ? 'abstract class' : 'class';
                let classDeclaration = classType + ' ' + this.name + this.fullGenericType;

                if (this.superclass != null) {
                    classDeclaration += ' extends ' + this.superclass;
                }

                /**
                 * @param {string[]} list
                 * @param {string} keyword
                 */
                function addSuperTypes(list, keyword) {
                    if (list.length == 0) return;

                    const length = list.length;
                    classDeclaration += ` ${ keyword } `;

                    for (let x = 0; x < length; x++) {
                        const isLast = x == length - 1;
                        const type = list[x];
                        classDeclaration += type;

                        if (!isLast) {
                            classDeclaration += ', ';
                        }
                    }
                }

                addSuperTypes(this.mixins, 'with');
                addSuperTypes(this.interfaces, 'implements');

                classDeclaration += ' {\n';
                replacement = classDeclaration + replacement;
            } else if (l == this.propsEndAtLine && this.constr != null && !this.hasConstructor) {
                replacement = this.constr + replacement;
                replacement = line + replacement;
            } else if (l == this.endsAtLine && this.isValid) {
                replacement = line + replacement;
                replacement = this.toInsert + replacement;
            } else {
                let rp = this.replacementAtLine(l);
                if (rp != null) {
                    if (!replacement.includes(rp))
                        replacement = rp + '\n' + replacement;
                } else {
                    replacement = line + replacement;
                }
            }
        }

        return removeEnd(replacement, '\n');
    }
}

class Imports {
    /**
     * @param {string} text
     */
    constructor(text) {
        this.values = [];
        this.startAtLine = null;
        this.endAtLine = null;
        this.rawImports = null;
        this.text = text;

        this.readImports();
    }

    get hasImports() {
        return this.values != null && this.values.length > 0;
    }

    get hasExportDeclaration() {
        return /^export /m.test(this.formatted);
    }

    get hasImportDeclaration() {
        return /^import /m.test(this.formatted);
    }

    get hasPreviousImports() {
        return this.startAtLine != null && this.endAtLine != null;
    }

    get didChange() {
        return !areStrictEqual(this.rawImports, this.formatted);
    }

    get range() {
        return new vscode.Range(
            new vscode.Position(this.startAtLine - 1, 0),
            new vscode.Position(this.endAtLine, 1),
        );
    }

    readImports() {
        this.rawImports = '';
        const lines = this.text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const isLast = i == lines.length - 1;

            if (line.startsWith('import') || line.startsWith('export') || line.startsWith('part')) {
                this.values.push(line);
                this.rawImports += `${line}\n`;
                if (this.startAtLine == null) {
                    this.startAtLine = i + 1;
                }

                if (isLast) {
                    this.endAtLine = i + 1;
                    break;
                }
            } else {
                const isLicenseComment = line.startsWith('//') && this.values.length == 0;
                const didEnd = !(isBlank(line) || line.startsWith('library') || isLicenseComment);

                if (isLast || didEnd) {
                    if (this.startAtLine != null) {
                        if (i > 0 && isBlank(lines[i - 1])) {
                            this.endAtLine = i - 1;
                        } else {
                            this.endAtLine = i;
                        }
                    }
                    break;
                }
            }
        }
    }

    get formatted() {
        if (!this.hasImports) return '';

        let workspace = projectName;

        if (workspace == null || workspace.length == 0) {
            const file = getEditor().document.uri;
            if (file.scheme === 'file') {
                const folder = vscode.workspace.getWorkspaceFolder(file);
                if (folder) {
                    workspace = path.basename(folder.uri.fsPath).replace('-', '_');
                }
            }
        }

        const dartImports = [];
        const packageImports = [];
        const packageLocalImports = [];
        const relativeImports = [];
        const partStatements = [];
        const exports = [];

        for (let imp of this.values) {
            if (imp.startsWith('export')) {
                exports.push(imp);
            } else if (imp.startsWith('part')) {
                partStatements.push(imp);
            } else if (imp.includes('dart:')) {
                dartImports.push(imp);
            } else if (workspace != null && imp.includes(`package:${workspace}`)) {
                packageLocalImports.push(imp);
            } else if (imp.includes('package:')) {
                packageImports.push(imp);
            } else {
                relativeImports.push(imp);
            }
        }

        let imps = '';

        /**
         * @param {any[]} imports
         */
        function addImports(imports) {
            imports.sort();
            for (let i = 0; i < imports.length; i++) {
                const isLast = i == imports.length - 1;
                const imp = imports[i];
                imps += imp + '\n';

                if (isLast) {
                    imps += '\n';
                }
            }
        }

        addImports(dartImports);
        addImports(packageImports);
        addImports(packageLocalImports);
        addImports(relativeImports);
        addImports(exports);
        addImports(partStatements);

        return removeEnd(imps, '\n');
    }

    /**
     * @param {string} imp
     */
    includes(imp) {
        return this.values.includes(imp);
    }

    /**
     * @param {string} imp
     */
    push(imp) {
        return this.values.push(imp);
    }

    /**
     * @param {string[]} imps
     */
    hastAtLeastOneImport(imps) {
        for (let imp of imps) {
            const impt = `import '${imp}';`;
            if (this.text.includes(impt) || this.includes(impt))
                return true;
        }
        return false;
    }

    /**
     * @param {string} imp
     * @param {string[]} validOverrides
     */
    requiresImport(imp, validOverrides = []) {
        const formattedImport = !imp.startsWith('import') ? "import '" + imp + "';" : imp;

        if (!this.includes(formattedImport) && !this.hastAtLeastOneImport(validOverrides)) {
            this.values.push(formattedImport);
        }
    }
}

class ClassField {
    /**
     * @param {String} type
     * @param {String} name
     * @param {number} line
     * @param {boolean} isFinal
     * @param {boolean} isConst
     */
    constructor(type, name, line = 1, isFinal = true, isConst = false, json = false) {
        this.rawType = type;
        this.name = toVarName(name);
        this.key = json ? name : varToKey(this.name);
        this.line = line;
        this.isFinal = isFinal;
        this.isConst = isConst;
        this.isEnum = false;
        this.isCollectionType = (/** @type {string} */ type) => this.rawType == type || this.rawType.startsWith(type + '<');
    }

    get type() {
        return this.isNullable ? removeEnd(this.rawType, '?') : this.rawType;
    }

    get isNullable() {
        return this.rawType.endsWith('?');
    }

    get isList() {
        return this.isCollectionType('List');
    }

    get isMap() {
        return this.isCollectionType('Map');
    }

    get isSet() {
        return this.isCollectionType('Set');
    }

    get isCollection() {
        return this.isList || this.isMap || this.isSet;
    }

    get collectionType() {
        if (this.isList || this.isSet) {
            const collection = this.isSet ? 'Set' : 'List';
            const type = this.rawType == collection ? 'dynamic' : this.rawType.replace(collection + '<', '').replace('>', '');
            return new ClassField(type, this.name, this.line, this.isFinal);
        }

        return this;
    }

    get isPrimitive() {
        let t = this.collectionType.type;
        return t == 'String' || t == 'num' || t == 'dynamic' || t == 'bool' || this.isDouble || this.isInt || this.isMap;
    }

    get isPrivate() {
        return this.name.startsWith('_');
    }

    get defValue() {
        if (this.isList) {
            return 'const []';
        } else if (this.isMap || this.isSet) {
            return 'const {}';
        } else {
            switch (this.type) {
                case 'String': return "''";
                case 'num':
                case 'int': return "0";
                case 'double': return "0.0";
                case 'bool': return 'false';
                case 'dynamic': return "null";
                default: return `${this.type}.init()`; // Updated to use init() for nested classes
            }
        }
    }

    get isInt() {
        return this.collectionType.type == 'int';
    }

    get isDouble() {
        return this.collectionType.type == 'double';
    }
}

class ClassPart {
    /**
     * @param {string} name
     * @param {number} startsAt
     * @param {number} endsAt
     * @param {string} current
     * @param {string} replacement
     */
    constructor(name, startsAt = null, endsAt = null, current = null, replacement = null) {
        this.name = name;
        this.startsAt = startsAt;
        this.endsAt = endsAt;
        this.current = current;
        this.replacement = replacement;
    }

    get isValid() {
        return this.startsAt != null && this.endsAt != null && this.current != null;
    }

    get startPos() {
        return new vscode.Position(this.startsAt, 0);
    }

    get endPos() {
        return new vscode.Position(this.endsAt, 0);
    }
}

// *** UPDATE 1: Modified DataClassGenerator with custom parse methods, init factory, and null-checked fromMap ***
class DataClassGenerator {
    /**
     * @param {String} text
     * @param {DartClass[]} clazzes
     * @param {boolean} fromJSON
     * @param {string} part
     */
    constructor(text, clazzes = null, fromJSON = false, part = null) {
        this.text = text;
        this.fromJSON = fromJSON;
        this.clazzes = clazzes == null ? this.parseAndReadClasses() : clazzes;
        this.imports = new Imports(text);
        this.part = part;
        this.generateDataClazzes();
        this.clazz = null;
    }

    get hasImports() {
        return this.imports.hasImports;
    }

    /**
     * @param {string} imp
     * @param {string[]} validOverrides
     */
    requiresImport(imp, validOverrides = []) {
        this.imports.requiresImport(imp, validOverrides);
    }

    /**
     * @param {string} part
     */
    isPartSelected(part) {
        return this.part == null || this.part == part;
    }

    generateDataClazzes() {
        const insertConstructor = readSetting('constructor.enabled') && this.isPartSelected('constructor');

        for (let clazz of this.clazzes) {
            this.clazz = clazz;

            if (insertConstructor)
                this.insertConstructor(clazz);

            if (!clazz.isWidget) {
                // *** UPDATE 2: Added custom parse methods and init factory ***
                // this.insertParseMethods(clazz);
                this.insertInitFactory(clazz);

                if (!clazz.isAbstract) {
                    if (readSetting('copyWith.enabled') && this.isPartSelected('copyWith'))
                        this.insertCopyWith(clazz);
                    if (readSetting('toMap.enabled') && this.isPartSelected('serialization'))
                        this.insertToMap(clazz);
                    if (readSetting('fromMap.enabled') && this.isPartSelected('serialization'))
                        this.insertFromMap(clazz);
                    if (readSetting('toJson.enabled') && this.isPartSelected('serialization'))
                        this.insertToJson(clazz);
                    if (readSetting('fromJson.enabled') && this.isPartSelected('serialization'))
                        this.insertFromJson(clazz);
                }

                if (readSetting('toString.enabled') && this.isPartSelected('toString'))
                    this.insertToString(clazz);

                if ((clazz.usesEquatable || readSetting('useEquatable')) && this.isPartSelected('useEquatable')) {
                    this.insertEquatable(clazz);
                } else {
                    if (readSetting('equality.enabled') && this.isPartSelected('equality'))
                        this.insertEquality(clazz);
                    if (readSetting('hashCode.enabled') && this.isPartSelected('equality'))
                        this.insertHash(clazz);
                }
            }
        }
    }

    /**
     * @param {string} name
     * @param {string} finder
     * @param {DartClass} clazz
     */
    findPart(name, finder, clazz) {
        const normalize = (/** @type {string} */ src) => {
            let result = '';
            let generics = 0;
            let prevChar = '';
            for (const char of src) {
                if (char == '<') generics++;
                if (char != ' ' && generics == 0) {
                    result += char;
                }

                if (prevChar != '=' && char == '>') generics--;
                prevChar = char;
            }

            return result;
        }

        const finderString = normalize(finder);
        const lines = clazz.classContent.split('\n');
        const part = new ClassPart(name);
        let curlies = 0;
        let singleLine = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineNum = clazz.startsAtLine + i;

            curlies += count(line, '{');
            curlies -= count(line, '}');

            if (part.startsAt == null && normalize(line).startsWith(finderString)) {
                if (line.includes('=>')) singleLine = true;
                if (curlies == 2 || singleLine) {
                    part.startsAt = lineNum;
                    part.current = line + '\n';
                }
            } else if (part.startsAt != null && part.endsAt == null && (curlies >= 2 || singleLine)) {
                part.current += line + '\n';
            } else if (part.startsAt != null && part.endsAt == null && curlies == 1) {
                part.endsAt = lineNum;
                part.current += line;
            }

            if (singleLine && part.startsAt != null && part.endsAt == null && line.trimRight().endsWith(';')) {
                part.endsAt = lineNum;
            }
        }

        return part.isValid ? part : null;
    }

    /**
     * @param {ClassField | string} prop
     * @param {{ "name": string; "text": string; "isThis": boolean; }[]} oldProps
     */
    findConstrParameter(prop, oldProps) {
        const name = typeof prop === 'string' ? prop : prop.name;
        for (let oldProp of oldProps) {
            if (name === oldProp.name) {
                return oldProp;
            }
        }

        return null;
    }

    /**
     * @param {DartClass} clazz
     */
    findOldConstrProperties(clazz) {
        if (!clazz.hasConstructor || clazz.constrStartsAtLine == clazz.constrEndsAtLine) {
            return [];
        }

        let oldConstr = '';
        let brackets = 0;
        let didFindConstr = false;
        for (let c of clazz.constr) {
            if (c == '(') {
                if (didFindConstr) oldConstr += c;
                brackets++;
                didFindConstr = true;
                continue;
            } else if (c == ')') {
                brackets--;
                if (didFindConstr && brackets == 0)
                    break;
            }

            if (brackets >= 1)
                oldConstr += c;
        }

        oldConstr = removeStart(oldConstr, ['{', '[']);
        oldConstr = removeEnd(oldConstr, ['}', ']']);

        let oldArguments = oldConstr.split('\n');
        const oldProperties = [];
        for (let arg of oldArguments) {
            let formatted = arg.replace('required', '').trim();
            if (formatted.indexOf('=') != -1) {
                formatted = formatted.substring(0, formatted.indexOf('=')).trim();
            }

            let name = null;
            let isThis = false;
            if (formatted.startsWith('this.')) {
                name = formatted.replace('this.', '');
                isThis = true;
            } else {
                const words = formatted.split(' ');
                if (words.length >= 1) {
                    const w = words[1];
                    if (!isBlank(w)) name = w;
                }
            }

            if (name != null) {
                oldProperties.push({
                    "name": removeEnd(name.trim(), ','),
                    "text": arg.trim() + '\n',
                    "isThis": isThis,
                });
            }
        }

        return oldProperties;
    }

    /**
     * @param {DartClass} clazz
     */
    insertConstructor(clazz) {
        const withDefaults = readSetting('constructor.default_values');

        let constr = '';
        let startBracket = '({';
        let endBracket = '})';

        if (clazz.constr != null) {
            if (clazz.constr.trimLeft().startsWith('const'))
                constr += 'const ';

            const fConstr = clazz.constr.replace('const', '').trimLeft();

            if (fConstr.startsWith(clazz.name + '([')) startBracket = '([';
            else if (fConstr.startsWith(clazz.name + '({')) startBracket = '({';
            else startBracket = '(';

            if (fConstr.includes('])')) endBracket = '])';
            else if (fConstr.includes('})')) endBracket = '})';
            else endBracket = ')';
        } else {
            if (clazz.isWidget)
                constr += 'const ';
        }

        constr += clazz.name + startBracket + '\n';

        if (clazz.isWidget) {
            let hasKey = false;
            let clazzConstr = clazz.constr || '';
            for (let line of clazzConstr.split('\n')) {
                if (line.trim().startsWith('Key? key')) {
                    hasKey = true;
                    break;
                }
            }

            if (!hasKey)
                constr += '  Key? key,\n';
        }

        const oldProperties = this.findOldConstrProperties(clazz);
        for (let prop of oldProperties) {
            if (!prop.isThis) {
                constr += '  ' + prop.text;
            }
        }

        for (let prop of clazz.properties) {
            const oldProperty = this.findConstrParameter(prop, oldProperties);
            if (oldProperty != null) {
                if (oldProperty.isThis)
                    constr += '  ' + oldProperty.text;

                continue;
            }

            const parameter = `this.${prop.name}`

            constr += '  ';

            if (!prop.isNullable) {
                const hasDefault = withDefaults && ((prop.isPrimitive || prop.isCollection) && prop.rawType != 'dynamic');
                const isNamedConstr = startBracket == '({' && endBracket == '})';

                if (hasDefault) {
                    constr += `${parameter} = ${prop.defValue},\n`;
                } else if (isNamedConstr) {
                    constr += `required ${parameter},\n`;
                } else {
                    constr += `${parameter},\n`;
                }
            } else {
                constr += `${parameter},\n`;
            }
        }

        const stdConstrEnd = () => {
            constr += endBracket + (clazz.isWidget ? ' : super(key: key);' : ';');
        }

        if (clazz.constr != null) {
            let i = null;
            if (clazz.constr.includes(' : ')) i = clazz.constr.indexOf(' : ') + 1;
            else if (clazz.constr.trimRight().endsWith('{')) i = clazz.constr.lastIndexOf('{');

            if (i != null) {
                let ending = clazz.constr.substring(i, clazz.constr.length);
                constr += `${endBracket} ${ending}`;
            } else {
                stdConstrEnd();
            }
        } else {
            stdConstrEnd();
        }

        if (clazz.hasConstructor) {
            clazz.constrDifferent = !areStrictEqual(clazz.constr, constr);
            if (clazz.constrDifferent) {
                constr = removeEnd(indent(constr), '\n');
                this.replace(new ClassPart('constructor', clazz.constrStartsAtLine, clazz.constrEndsAtLine, clazz.constr, constr), clazz);
            }
        } else {
            clazz.constrDifferent = true;
            this.append(constr, clazz, true);
        }
    }

    /**
     * @param {DartClass} clazz
     */
    insertCopyWith(clazz) {
        const usesValueGetter = readSetting('copyWith.usesValueGetter');
        let addImportForValueGetter = false;
        let method = clazz.type + ' copyWith({\n';
        for (const prop of clazz.properties) {
            if (usesValueGetter && prop.isNullable) {
                if (!addImportForValueGetter) addImportForValueGetter = true;
                method += `  ValueGetter<${prop.rawType}>? ${prop.name},\n`;
            } else {
                method += `  ${prop.type}? ${prop.name},\n`;
            }
        }
        method += '}) {\n';
        method += `  return ${clazz.type}(\n`;

        for (let p of clazz.properties) {
            if (usesValueGetter && p.isNullable) {
                method += `    ${ clazz.hasNamedConstructor ? `${ p.name }: ` : '' }${ p.name } != null ? ${ p.name }() : this.${ p.name },\n`;
            } else {
                method += `    ${ clazz.hasNamedConstructor ? `${ p.name }: ` : '' }${ p.name } ?? this.${ p.name },\n`;
            }
        }

        method += '  );\n'
        method += '}';

        if (addImportForValueGetter) {
            this.requiresImport('package:flutter/widgets.dart');
        }

        this.appendOrReplace('copyWith', method, `${clazz.name} copyWith(`, clazz);
    }

    /**
     * @param {DartClass} clazz
     */
    insertToMap(clazz) {
        let props = clazz.properties;
        /**
         * @param {ClassField} prop
         */
        function customTypeMapping(prop, name = null, endFlag = ',\n') {
            prop = prop.isCollection ? prop.collectionType : prop;
            name = name == null ? prop.name : name;

            const nullSafe = prop.isNullable ? '?' : '';

            switch (prop.type) {
                case 'DateTime':
                    return `${name}${nullSafe}.millisecondsSinceEpoch${endFlag}`;
                case 'Color':
                    return `${name}${nullSafe}.value${endFlag}`;
                case 'IconData':
                    return `${name}${nullSafe}.codePoint${endFlag}`
                default:
                    return `${name}${!prop.isPrimitive ? `${nullSafe}.toMap()` : ''}${endFlag}`;
            }
        }

        let method = `Map<String, dynamic> toMap() {\n`;
        method += '  return {\n';
        for (let p of props) {
            method += `    '${p.key}': `;

            if (p.isEnum) {
                method += `${p.name}?.index,\n`;
            } else if (p.isCollection) {
                const nullSafe = p.isNullable ? '?' : '';

                if (p.isMap || p.collectionType.isPrimitive) {
                    const mapFlag = p.isSet ? `${nullSafe}.toList()` : '';
                    method += `${p.name}${mapFlag},\n`;
                } else {
                    method += `${p.name}${nullSafe}.map((x) => ${customTypeMapping(p, 'x', '')})${nullSafe}.toList(),\n`
                }
            } else {
                method += customTypeMapping(p);
            }
            if (p.name == props[props.length - 1].name) method += '  };\n';
        }
        method += '}';

        this.appendOrReplace('toMap', method, 'Map<String, dynamic> toMap()', clazz);
    }

    // *** UPDATE 3: Modified fromMap to include null check for nested objects ***

/**
 * @param {DartClass} clazz
 */
insertFromMap(clazz) {
    let props = clazz.properties;

    /**
     * @param {ClassField} prop
     */
    function customTypeMapping(prop, value = null) {
        prop = prop.isCollection ? prop.collectionType : prop;
        value = value == null ? "map['" + prop.key + "']" : value;

        switch (prop.type) {
            case 'DateTime':
                return `DateTime.fromMillisecondsSinceEpoch(ParsingUtils.parseInt(${value}))`;
            case 'Color':
                return `Color(ParsingUtils.parseInt(${value}))`;
            case 'IconData':
                return `IconData(ParsingUtils.parseInt(${value}), fontFamily: 'MaterialIcons')`;
            default:
                return `${prop.type}.fromMap(${value})`;
        }
    }

    let method = `factory ${clazz.name}.fromMap(Map<String, dynamic> map) {\n`;
    method += '  return ' + clazz.type + '(\n';
    for (let p of props) {
        method += `    ${clazz.hasNamedConstructor ? `${p.name}: ` : ''}`;

        const value = `map['${p.key}']`;
        const addNullCheck = !p.isPrimitive && p.isNullable;

        if (addNullCheck) {
            method += `${value} != null ? `;
        }

        if (p.isEnum) {
            method += `${p.rawType}.values[ParsingUtils.parseInt(${value})]`;
        } else if (p.isCollection) {
            method += `${p.type}.from(`;
            if (p.isPrimitive) {
                if (p.isDouble) {
                    method += `${value}?.map((x) => ParsingUtils.parseDouble(x)) ?? const []`;
                } else if (p.isInt) {
                    method += `${value}?.map((x) => ParsingUtils.parseInt(x)) ?? const []`;
                } else if (p.type === 'String') {
                    method += `${value}?.map((x) => ParsingUtils.parseString(x)) ?? const []`;
                } else if (p.type === 'bool') {
                    method += `${value}?.map((x) => ParsingUtils.parseBool(x)) ?? const []`;
                } else {
                    method += `${value} ?? const []`;
                }
            } else {
                method += `${value}?.map((x) => ${customTypeMapping(p, 'x')}) ?? const []`;
            }
            method += ')';
        } else if (p.isPrimitive) {
            if (p.isDouble) {
                method += `ParsingUtils.parseDouble(${value})`;
            } else if (p.isInt) {
                method += `ParsingUtils.parseInt(${value})`;
            } else if (p.type === 'String') {
                method += `ParsingUtils.parseString(${value})`;
            } else if (p.type === 'bool') {
                method += `ParsingUtils.parseBool(${value})`;
            } else {
                method += `${value}`;
            }
        } else {
            method += `${value} == null ? ${p.type}.init() : ${customTypeMapping(p)}`; // Single null check for non-collection objects
        }

        if (addNullCheck) {
            method += ` : ${p.defValue}`; // Keep default value for nullable non-primitive types
        }

        method += ',\n';

        const isLast = p.name == props[props.length - 1].name;
        if (isLast) method += '  );\n';
    }
    method += '}';

    this.appendOrReplace('fromMap', method, `factory ${clazz.name}.fromMap(Map<String, dynamic> map)`, clazz);
}
    /**
     * @param {DartClass} clazz
     */
    insertToJson(clazz) {
        this.requiresImport('dart:convert');

        const method = 'String toJson() => json.encode(toMap());';
        this.appendOrReplace('toJson', method, 'String toJson()', clazz);
    }

    /**
     * @param {DartClass} clazz
     */
    insertFromJson(clazz) {
        this.requiresImport('dart:convert');

        const method = `factory ${clazz.name}.fromJson(String source) => ${clazz.name}.fromMap(json.decode(source));`;
        this.appendOrReplace('fromJson', method, `factory ${clazz.name}.fromJson(String source)`, clazz);
    }

    /**
     * @param {DartClass} clazz
     */
    insertToString(clazz) {
        const short = clazz.fewProps;
        const props = clazz.properties;
        let method = '@override\n';
        method += `String toString() ${!short ? '{\n' : '=>'}`;
        method += `${!short ? '  return' : ''} '` + `${clazz.name}(`;
        for (let p of props) {
            const name = p.name;
            const isFirst = name == props[0].name;
            const isLast = name == props[props.length - 1].name;

            if (!isFirst)
                method += ' ';

            method += name + ': $' + name + ',';

            if (isLast) {
                method = removeEnd(method, ',');
                method += ")';" + (short ? '' : '\n');
            }
        }
        method += !short ? '}' : '';

        this.appendOrReplace('toString', method, 'String toString()', clazz);
    }

    /**
     * @param {DartClass} clazz
     */
    insertEquality(clazz) {
        const props = clazz.properties;
        const hasCollection = props.find((p) => p.isCollection) != undefined;

        let collectionEqualityFn;
        if (hasCollection) {
            if (isFlutter) {
                this.requiresImport('package:flutter/foundation.dart');
            } else {
                this.requiresImport('package:collection/collection.dart');

                collectionEqualityFn = 'collectionEquals';
                const isListOnly = props.find((p) => p.isCollection && !p.isList) == undefined;
                if (isListOnly) collectionEqualityFn = 'listEquals';
                const isMapOnly = props.find((p) => p.isCollection && !p.isMap) == undefined;
                if (isMapOnly) collectionEqualityFn = 'mapEquals';
                const isSetOnly = props.find((p) => p.isCollection && !p.isSet) == undefined;
                if (isSetOnly) collectionEqualityFn = 'setEquals';
            }
        }

        let method = '@override\n';
        method += 'bool operator ==(Object other) {\n';
        method += '  if (identical(this, other)) return true;\n';
        if (hasCollection && !isFlutter)
            method += `  final ${collectionEqualityFn} = const DeepCollectionEquality().equals;\n`
        method += '\n';
        method += '  return other is ' + clazz.type + ' &&\n';
        for (let prop of props) {
            if (prop.isCollection) {
                if (isFlutter) collectionEqualityFn = prop.isSet ? 'setEquals' : prop.isMap ? 'mapEquals' : 'listEquals';
                method += `    ${collectionEqualityFn}(other.${prop.name}, ${prop.name})`;
            } else {
                method += `    other.${prop.name} == ${prop.name}`;
            }
            if (prop.name != props[props.length - 1].name) method += ' &&\n';
            else method += ';\n';
        }
        method += '}';

        this.appendOrReplace('equality', method, 'bool operator ==', clazz);
    }

    /**
     * @param {DartClass} clazz
     */
    insertHash(clazz) {
        const useJenkins = readSetting('hashCode.use_jenkins');
        const short = !useJenkins && clazz.fewProps;
        const props = clazz.properties;
        let method = '@override\n';
        method += `int get hashCode ${short ? '=>' : '{\n  return '}`;

        if (useJenkins) {
            this.requiresImport('dart:ui', [
                'package:flutter/material.dart',
                'package:flutter/cupertino.dart',
                'package:flutter/widgets.dart'
            ]);

            method += `hashList([\n`;
            for (let p of props) {
                method += '    ' + p.name + `,\n`;
            }
            method += '  ]);';
        } else {
            for (let p of props) {
                const isFirst = p == props[0];
                method += `${isFirst && !short ? '' : short ? ' ' : '    '}${p.name}.hashCode`;
                if (p == props[props.length - 1]) {
                    method += ';';
                } else {
                    method += ` ^${!short ? '\n' : ''}`;
                }
            }
        }

        if (!short) method += '\n}';

        this.appendOrReplace('hashCode', method, 'int get hashCode', clazz);
    }

    /**
     * @param {DartClass} clazz
     */
    addEquatableDetails(clazz) {
        if (clazz.hasSuperclass && clazz.superclass.includes('Base')) return;

        this.requiresImport('package:equatable/equatable.dart');

        if (!clazz.usesEquatable) {
            if (clazz.hasSuperclass) {
                this.addMixin('EquatableMixin');
            } else {
                this.setSuperClass('Equatable');
            }
        }
    }

    /**
     * @param {DartClass} clazz
     */
    insertEquatable(clazz) {
        this.addEquatableDetails(clazz);

        const props = clazz.properties;
        let hasNullableProps = false;

        for (const prop of props) {
            if (!hasNullableProps && prop.isNullable) hasNullableProps = true;
        }

        const short = props.length <= 4;
        const split = short ? ', ' : ',\n';
        let method = '@override\n';

        if (hasNullableProps) {
            method += `List<Object?> get props ${!short ? '{\n' : '=>'}`;
        } else {
            method += `List<Object> get props ${!short ? '{\n' : '=>'}`;
        }

        method += `${!short ? '  return' : ''} ` + '[' + (!short ? '\n' : '');
        for (let prop of props) {
            const isLast = prop.name == props[props.length - 1].name;
            const inset = !short ? '    ' : '';
            method += inset + prop.name + split;

            if (isLast) {
                if (short) method = removeEnd(method, split);
                method += (!short ? '  ' : '') + '];' + (!short ? '\n' : '');
            }
        }
        method += !short ? '}' : '';

        this.appendOrReplace('props', method, 'List<Object> get props', clazz);
    }

    // *** UPDATE 4: Added custom parse methods ***

    //     /**
//  * @param {DartClass} clazz
//  */
// insertParseMethods(clazz) {
//     const parseDoubleMethod = `
//   static double parseDouble(dynamic value) {
//     if (value == null) return 0.0;
//     if (value is double) return value;
//     if (value is int) return value.toDouble();
//     if (value is String) return double.tryParse(value) ?? 0.0;
//     return 0.0;
//   }`;

//     const parseIntMethod = `
//   static int parseInt(dynamic value) {
//     if (value == null) return 0;
//     if (value is int) return value;
//     if (value is String) return int.tryParse(value) ?? 0;
//     return 0;
//   }`;

//     const parseStringMethod = `
//   static String parseString(dynamic value) {
//     if (value == null) return '';
//     return value.toString();
//   }`;

//     // Use appendOrReplace to avoid duplicates
//     this.appendOrReplace('parseDouble', parseDoubleMethod, `static double parseDouble(dynamic value)`, clazz);
//     this.appendOrReplace('parseInt', parseIntMethod, `static int parseInt(dynamic value)`, clazz);
//     this.appendOrReplace('parseString', parseStringMethod, `static String parseString(dynamic value)`, clazz);
// }

/**
 * @param {DartClass} clazz
 */
insertInitFactory(clazz) {
    let method = `factory ${clazz.name}.init() => ${clazz.type}(\n`;
    
    for (let prop of clazz.properties) {
        let defaultValue;
        if (prop.isCollection) {
            defaultValue = prop.isList ? 'const []' : 'const {}';
        } else {
            switch (prop.type) {
                case 'int':
                case 'num':
                    defaultValue = '0';
                    break;
                case 'double':
                    defaultValue = '0.0';
                    break;
                case 'String':
                    defaultValue = '""';
                    break;
                case 'bool':
                    defaultValue = 'false';
                    break;
                default:
                    defaultValue = `${prop.type}.init()`; // Use init() for nested classes
            }
        }
        
        method += `    ${clazz.hasNamedConstructor ? `${prop.name}: ` : ''}${defaultValue},\n`;
    }
    
    method += '  );';

    // Use appendOrReplace to avoid duplicates
    this.appendOrReplace('init', method, `factory ${clazz.name}.init()`, clazz);
}

    /**
     * @param {string} mixin
     */
    addMixin(mixin) {
        const mixins = this.clazz.mixins;
        if (!mixins.includes(mixin)) {
            mixins.push(mixin);
        }
    }

    /**
     * @param {string} impl
     */
    addInterface(impl) {
        const interfaces = this.clazz.interfaces;
        if (!interfaces.includes(impl)) {
            interfaces.push(impl);
        }
    }

    /**
     * @param {string} clazz
     */
    setSuperClass(clazz) {
        this.clazz.superclass = clazz;
    }

    /**
     * @param {string} name
     * @param {string} n
     * @param {string} finder
     * @param {DartClass} clazz
     */
    appendOrReplace(name, n, finder, clazz) {
        let part = this.findPart(name, finder, clazz);
        let replacement = removeEnd(indent(n.replace('@override\n', '')), '\n');

        if (part != null) {
            part.replacement = replacement;
            if (!areStrictEqual(part.current, part.replacement)) {
                this.replace(part, clazz);
            }
        } else {
            this.append(n, clazz);
        }
    }

    /**
     * @param {string} method
     * @param {DartClass} clazz
     */
    append(method, clazz, constr = false) {
        let met = indent(method);
        constr ? clazz.constr = met : clazz.toInsert += '\n' + met;
    }

    /**
     * @param {ClassPart} part
     * @param {DartClass} clazz
     */
    replace(part, clazz) {
        clazz.toReplace.push(part);
    }

    parseAndReadClasses() {
        let clazzes = [];
        let clazz = new DartClass();

        let lines = this.text.split('\n');
        let curlyBrackets = 0;
        let brackets = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const linePos = i + 1;
            const classLine = line.trimLeft().startsWith('class ') || line.trimLeft().startsWith('abstract class ');

            if (classLine) {
                clazz = new DartClass();
                clazz.startsAtLine = linePos;

                let classNext = false;
                let extendsNext = false;
                let implementsNext = false;
                let mixinsNext = false;

                curlyBrackets = 0;
                brackets = 0;

                const words = this.splitWhileMaintaingGenerics(line);
                for (let word of words) {
                    word = word.trim();
                    if (word.length > 0) {
                        if (word == 'class') {
                            classNext = true;
                        } else if (word == 'extends') {
                            extendsNext = true;
                        } else if (extendsNext) {
                            extendsNext = false;
                            clazz.superclass = word;
                        } else if (word == 'with') {
                            mixinsNext = true;
                            extendsNext = false;
                            implementsNext = false;
                        } else if (word == 'implements') {
                            mixinsNext = false;
                            extendsNext = false;
                            implementsNext = true;
                        } else if (classNext) {
                            classNext = false;

                            if (word.includes('<')) {
                                clazz.fullGenericType = word.substring(
                                    word.indexOf('<'),
                                    word.lastIndexOf('>') + 1,
                                );

                                word = word.substring(0, word.indexOf('<'));
                            }

                            clazz.name = word;
                        } else if (mixinsNext) {
                            const mixin = removeEnd(word, ',').trim();

                            if (mixin.length > 0) {
                                clazz.mixins.push(mixin);
                            }
                        } else if (implementsNext) {
                            const impl = removeEnd(word, ',').trim();

                            if (impl.length > 0) {
                                clazz.interfaces.push(impl);
                            }
                        }
                    }
                }

                if (!clazz.isState) {
                    clazzes.push(clazz);
                }
            }

            if (clazz.classDetected) {
                curlyBrackets += count(line, '{');
                curlyBrackets -= count(line, '}');
                brackets += count(line, '(');
                brackets -= count(line, ')');

                const includesConstr = line.replace('const', '').trimLeft().startsWith(clazz.name + '(');
                if (includesConstr && !classLine) {
                    clazz.constrStartsAtLine = linePos;
                }

                if (clazz.constrStartsAtLine != null && clazz.constrEndsAtLine == null) {
                    clazz.constr = clazz.constr == null ? line + '\n' : clazz.constr + line + '\n';

                    if (brackets == 0) {
                        clazz.constrEndsAtLine = linePos;
                        clazz.constr = removeEnd(clazz.constr, '\n');
                    }
                }

                clazz.classContent += line;
                if (curlyBrackets != 0) {
                    clazz.classContent += '\n';
                } else {
                    clazz.endsAtLine = linePos;
                    clazz = new DartClass();
                }

                if (brackets == 0 && curlyBrackets == 1) {
                    const lineValid =
                        !line.trimLeft().startsWith(clazz.name) &&
                        !line.trimLeft().startsWith('//') &&
                        !includesOne(line, ['{', '}', '=>', '@'], false) &&
                        !includesOne(line, ['static', 'set', 'get', 'return', 'factory']) &&
                        !includesAll(line, ['final ', '=']) &&
                        (clazz.constrStartsAtLine == null || line.includes('final ')) &&
                        !line.replace(/\s/g, '').endsWith(');');

                    if (lineValid) {
                        let type = null;
                        let name = null;
                        let isFinal = false;
                        let isConst = false;

                        const words = line.trim().split(' ');
                        for (let i = 0; i < words.length; i++) {
                            const word = words[i];
                            const isLast = i == words.length - 1;

                            if (word.length > 0 && word != '}' && word != '{') {
                                if (word == 'final') {
                                    isFinal = true;
                                } else if (i == 0 && word == 'const') {
                                    isConst = true;
                                }

                                if (word != 'final' && word != 'const') {
                                    let isVariable = word.endsWith(';') || (!isLast && (words[i + 1] == '='));
                                    isVariable = isVariable && !includesOne(word, ['(', ')']);
                                    if (isVariable) {
                                        if (name == null)
                                            name = removeEnd(word, ';');
                                    } else {
                                        if (type == null) type = word;
                                        else if (name == null) type += ' ' + word;
                                    }
                                }
                            }
                        }

                        if (type != null && name != null) {
                            const prop = new ClassField(type, name, linePos, isFinal, isConst);

                            if (i > 0) {
                                const prevLine = lines[i - 1];
                                prop.isEnum = prevLine.match(/.*\/\/(\s*)enum/) != null;
                            }

                            clazz.properties.push(prop);
                        }
                    }
                }
            }
        }

        return clazzes;
    }

    /**
     * @param {string} line
     */
    splitWhileMaintaingGenerics(line) {
        let words = [];
        let index = 0;
        let generics = 0;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            const isCurly = char == '{';
            const isSpace = char == ' ';

            if (char == '<') generics++;
            if (char == '>') generics--;

            if (generics == 0 && (isSpace || isCurly)) {
                const word = line.substring(index, i).trim();

                if (word.length == 0) continue;
                const isOnlyGeneric = word.startsWith('<');

                if (isOnlyGeneric) {
                    words[words.length - 1] = words[words.length - 1] + word;
                } else {
                    words.push(word);
                }

                if (isCurly) {
                    break;
                }

                index = i;
            }
        }

        return words;
    }
}

class DartFile {
    /**
     * @param {DartClass} clazz
     * @param {string} content
     */
    constructor(clazz, content = null) {
        this.clazz = clazz;
        this.name = createFileName(clazz.name);
        this.content = content || clazz.classContent;
    }
}

class JsonReader {
    /**
     * @param {string} source
     * @param {string} className
     */
    constructor(source, className) {
        this.json = this.toPlainJson(source);

        this.clazzName = capitalize(className);
        this.clazzes = [];
        this.files = [];

        this.error = this.checkJson();
    }

    async checkJson() {
        const isArray = this.json.startsWith('[');
        if (isArray && !this.json.includes('{')) {
            return 'Primitive JSON arrays are not supported! Please serialize them directly.';
        }

        if (await this.generateFiles()) {
            return 'The provided JSON is malformed or couldn\'t be parsed!';
        }

        return null;
    }

    /**
     * @param {string} source
     */
    toPlainJson(source) {
        return source.replace(new RegExp(' ', 'g'), '').replace(new RegExp('\n', 'g'), '');
    }

    /**
     * @param {any} value
     */
    getPrimitive(value) {
        let type = typeof (value);
        let sType = null;

        if (type === 'number') {
            sType = Number.isInteger(value) ? 'int' : 'double';
        } else if (type === 'string') {
            sType = 'String'
        } else if (type === 'boolean') {
            sType = 'bool';
        }

        return sType;
    }

    /**
     * @param {any} object
     * @param {string} key
     */
    getClazzes(object, key) {
        let clazz = new DartClass();
        clazz.startsAtLine = 1;
        clazz.name = capitalize(key);

        let isArray = false;
        if (object instanceof Array) {
            isArray = true;
            clazz.isArray = true;
            clazz.name += 's';
        } else {
            this.clazzes.push(clazz);
        }

        let i = 1;
        clazz.classContent += 'class ' + clazz.name + ' {\n';
        for (let key in object) {
            let k = !isArray ? key : removeEnd(clazz.name.toLowerCase(), 's');

            let value = object[key];
            let type = this.getPrimitive(value);

            if (type == null) {
                if (value instanceof Array) {
                    if (value.length > 0) {
                        let listType = k;
                        if (k.endsWith('ies')) listType = removeEnd(k, 'ies') + 'y';
                        if (k.endsWith('s')) listType = removeEnd(k, 's');
                        const i0 = this.getPrimitive(value[0]);

                        if (i0 == null) {
                            this.getClazzes(value[0], listType);
                            type = 'List<' + capitalize(listType) + '>';
                        } else {
                            type = 'List<' + i0 + '>';
                        }
                    } else {
                        type = 'List<dynamic>';
                    }
                } else {
                    this.getClazzes(value, k);
                    type = !isArray ? capitalize(k) : `List<${capitalize(k)}>`;
                }
            }

            clazz.properties.push(new ClassField(type, k, ++i, true, false, true));
            clazz.classContent += `  final ${type} ${toVarName(k)};\n`;

            if (isArray) break;
        }
        clazz.endsAtLine = ++i;
        clazz.classContent += '}';
    }

    /**
     * @param {string} property
     */
    getGeneratedTypeCount(property) {
        let p = new ClassField(property, 'x');
        let i = 0;
        if (!p.isPrimitive) {
            for (let clazz of this.clazzes) {
                if (clazz.name == p.rawType) {
                    i++;
                }
            }
        }

        return i;
    }

    async generateFiles() {
        try {
            const json = JSON.parse(this.json);
            this.getClazzes(json, this.clazzName);
            this.removeDuplicates();

            for (let clazz of this.clazzes) {
                this.files.push(new DartFile(clazz));
            }

            return false;
        } catch (e) {
            console.log(e.msg);
            return true;
        }
    }

    removeDuplicates() {
        let result = [];
        let clazzes = this.clazzes.map((item) => item.classContent);
        clazzes.forEach((item, index) => {
            if (clazzes.indexOf(item) == index) {
                result.push(this.clazzes[index]);
            }
        });

        this.clazzes = result;
    }

    /**
     * @param {DataClassGenerator} generator
     */
    addGeneratedFilesAsImport(generator) {
        const clazz = generator.clazzes[0];
        for (let prop of clazz.properties) {
            if (this.getGeneratedTypeCount(prop.collectionType.rawType) == 1) {
                const imp = `import '${createFileName(prop.collectionType.rawType)}.dart';`;
                generator.imports.push(imp);
            }
        }
    }

    // /**
    //  * @param {vscode.Progress} progress
    //  * @param {boolean} separate
    //  */
    // async commitJson(progress, separate) {
    //     let path = getCurrentPath();
    //     let fileContent = '';

    //     const length = this.files.length;
    //     for (let i = 0; i < length; i++) {
    //         const file = this.files[i];
    //         const isLast = i == length - 1;
    //         const generator = new DataClassGenerator(file.content, [file.clazz], true);

    //         if (separate)
    //             this.addGeneratedFilesAsImport(generator)

    //         const imports = `${generator.imports.formatted}\n`;

    //         progress.report({
    //             increment: ((1 / length) * 100),
    //             message: `Creating file ${file.name}...`
    //         });

    //         if (separate) {
    //             const clazz = generator.clazzes[0];

    //             const replacement = imports + clazz.generateClassReplacement();
    //             if (i > 0) {
    //                 await writeFile(replacement, file.name, false, path);
    //             } else {
    //                 await getEditor().edit(editor => {
    //                     editorReplace(editor, 0, null, replacement);
    //                 });
    //             }

    //             await new Promise(resolve => setTimeout(() => resolve(), 120));
    //         } else {
    //             for (let clazz of generator.clazzes) {
    //                 fileContent += clazz.generateClassReplacement() + '\n\n';
    //             }

    //             if (isLast) {
    //                 fileContent = removeEnd(fileContent, '\n\n');
    //                 await getEditor().edit(editor => {
    //                     editorReplace(editor, 0, null, fileContent);
    //                     editorInsert(editor, 0, imports);
    //                 });
    //             }
    //         }
    //     }
    // }


    /**
     * @param {vscode.Progress} progress
     * @param {boolean} separate
     */

    async commitJson(progress, separate) {
        let path = getCurrentPath();
        let fileContent = '';

        const length = this.files.length;
        for (let i = 0; i < length; i++) {
            const file = this.files[i];
            const isLast = i == length - 1;
            const generator = new DataClassGenerator(file.content, [file.clazz], true);

            if (separate) {
                this.addGeneratedFilesAsImport(generator);
            }

            const imports = `${generator.imports.formatted}\n`;

            progress.report({
                increment: ((1 / length) * 100),
                message: `Creating file ${file.name}...`
            });

            try {
                if (separate) {
                    const clazz = generator.clazzes[0];
                    const replacement = imports + clazz.generateClassReplacement();
                    if (i > 0) {
                        await writeFile(replacement, file.name, false, path);
                    } else {
                        await getEditor().edit(editor => {
                            editorReplace(editor, 0, null, replacement);
                        });
                    }
                } else {
                    for (let clazz of generator.clazzes) {
                        fileContent += clazz.generateClassReplacement() + '\n\n';
                    }

                    if (isLast) {
                        fileContent = removeEnd(fileContent, '\n\n');
                        await getEditor().edit(editor => {
                            editorReplace(editor, 0, null, fileContent);
                            editorInsert(editor, 0, imports);
                        });
                    }
                }
            } catch (error) {
                console.error(`Error processing file ${file.name}:`, error);
                vscode.window.showErrorMessage(`Error processing ${file.name}: ${error.message}`);
                continue; // Continue with next file
            }

            // Small delay to prevent overwhelming the UI
            await new Promise(resolve => setTimeout(() => resolve(), 120));
        }
    }
}

class DataClassCodeActions {
    constructor() {
        this.clazz = new DartClass();
        this.generator = null;
        this.document = getDoc();
        this.line = '';
        this.range;
    }

    get uri() {
        return this.document.uri;
    }

    get lineNumber() {
        return this.range.start.line + 1;
    }

    get charPos() {
        return this.range.start.character;
    }

    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Range} range
     */
    provideCodeActions(document, range) {
        if (!readSetting('quick_fixes')) {
            return;
        }

        this.range = range;
        this.document = document;
        this.line = document.lineAt(range.start).text;
        this.generator = new DataClassGenerator(document.getText());
        this.clazz = this.getClass();

        const codeActions = [
            this.createImportsFix(),
        ];

        if (this.clazz == null || !this.clazz.isValid) {
            return codeActions;
        }

        const line = this.lineNumber;
        const clazz = this.clazz;
        const isAtClassDeclaration = line == clazz.startsAtLine;
        const isInProperties = clazz.properties.find((p) => p.line == line) != undefined;
        const isInConstrRange = line >= clazz.constrStartsAtLine && line <= clazz.constrEndsAtLine;
        if (!(isAtClassDeclaration || isInProperties || isInConstrRange)) return codeActions;

        if (!this.clazz.isWidget)
            codeActions.push(this.createDataClassFix(this.clazz));

        if (readSetting('constructor.enabled'))
            codeActions.push(this.createConstructorFix());

        if (!this.clazz.isWidget) {
            if (!this.clazz.isAbstract) {
                if (readSetting('copyWith.enabled'))
                    codeActions.push(this.createCopyWithFix());
                if (readSettings(['toMap.enabled', 'fromMap.enabled', 'toJson.enabled', 'fromJson.enabled']))
                    codeActions.push(this.createSerializationFix());
            }

            if (readSetting('toString.enabled'))
                codeActions.push(this.createToStringFix());

            if (clazz.usesEquatable || readSetting('useEquatable'))
                codeActions.push(this.createUseEquatableFix());
            else {
                if (readSettings(['equality.enabled', 'hashCode.enabled']))
                    codeActions.push(this.createEqualityFix());
            }
        }

        return codeActions;
    }

    /**
     * @param {string} description
     * @param {(arg0: vscode.WorkspaceEdit) => void} editor
     */
    createFix(description, editor) {
        const fix = new vscode.CodeAction(description, vscode.CodeActionKind.QuickFix);
        const edit = new vscode.WorkspaceEdit();
        editor(edit);
        fix.edit = edit;
        return fix;
    }

    /**
     * @param {DartClass} clazz
     */
    createDataClassFix(clazz) {
        if (clazz.didChange) {
            const fix = new vscode.CodeAction('Generate data class', vscode.CodeActionKind.QuickFix);
            fix.edit = this.getClazzEdit(clazz);
            return fix;
        }
    }

    /**
     * @param {string} part
     * @param {string} description
     */
    constructQuickFix(part, description) {
        const generator = new DataClassGenerator(this.document.getText(), null, false, part);
        const fix = new vscode.CodeAction(description, vscode.CodeActionKind.QuickFix);
        const clazz = this.findQuickFixClazz(generator);
        if (clazz != null && clazz.didChange) {
            fix.edit = this.getClazzEdit(clazz, generator.imports);
            return fix;
        }
    }

    /** @param {DataClassGenerator} generator */
    findQuickFixClazz(generator) {
        for (let clazz of generator.clazzes) {
            if (clazz.name == this.clazz.name)
                return clazz;
        }
    }

    /**
     * @param {DartClass} clazz
     */
    getClazzEdit(clazz, imports = null) {
        return getReplaceEdit(clazz, imports || this.generator.imports);
    }

    createConstructorFix() {
        return this.constructQuickFix('constructor', 'Generate constructor');
    }

    createCopyWithFix() {
        return this.constructQuickFix('copyWith', 'Generate copyWith');
    }

    createSerializationFix() {
        return this.constructQuickFix('serialization', 'Generate JSON serialization');
    }

    createToStringFix() {
        return this.constructQuickFix('toString', 'Generate toString');
    }

    createEqualityFix() {
        return this.constructQuickFix('equality', 'Generate equality');
    }

    createUseEquatableFix() {
        return this.constructQuickFix('useEquatable', `Generate Equatable`);
    }

    createImportsFix() {
        const imports = new Imports(this.document.getText());
        if (!imports.didChange) return;

        const inImportsRange = this.lineNumber >= imports.startAtLine && this.lineNumber <= imports.endAtLine;
        if (inImportsRange) {
            let title = 'Sort imports';
            if (imports.hasImportDeclaration && imports.hasExportDeclaration) {
                title = 'Sort imports/exports';
            } else if (imports.hasExportDeclaration) {
                title = 'Sort exports';
            }

            return this.createFix(title, (edit) => {
                edit.replace(this.uri, imports.range, imports.formatted);
            });
        }
    }

    getClass() {
        for (let clazz of this.generator.clazzes) {
            if (clazz.startsAtLine <= this.lineNumber && clazz.endsAtLine >= this.lineNumber) {
                return clazz;
            }
        }
    }
}

/**
 * @param {any} values
 * @param {Imports} imports
 */
function getReplaceEdit(values, imports = null, showLogs = false) {
    const clazzes = values instanceof DartClass ? [values] : values;
    const hasMultiple = clazzes.length > 1;
    const edit = new vscode.WorkspaceEdit();
    const uri = getDoc().uri;

    const noChanges = [];
    for (var i = clazzes.length - 1; i >= 0; i--) {
        const clazz = clazzes[i];

        if (clazz.isValid) {
            if (clazz.didChange) {
                let replacement = clazz.generateClassReplacement();
                if (!clazz.isLastInFile) {
                    replacement += '\n';
                }

                if (!isBlank(replacement)) {
                    edit.replace(uri, new vscode.Range(
                        new vscode.Position((clazz.startsAtLine - 1), 0),
                        new vscode.Position(clazz.endsAtLine, 1)
                    ), replacement);
                }
            } else if (showLogs) {
                noChanges.push(clazz.name);
                if (i == 0) {
                    const info = noChanges.length == 1 ? `class ${noChanges[0]}` : `classes ${noChanges.join(', ')}`;
                    showInfo(`No changes detected for ${info}`);
                }
            }
        } else if (showLogs) {
            showError(clazz.issue);
        }
    }

    if (imports != null && imports.hasImports) {
        const areImportsseparated = !hasMultiple || (imports.startAtLine || 0) < clazzes[0].startsAtLine - 1;
        if (imports.hasPreviousImports && areImportsseparated) {
            edit.replace(uri, imports.range, imports.formatted);
        } else {
            edit.insert(uri, new vscode.Position(imports.startAtLine, 0), imports.formatted + '\n');
        }
    }

    return edit;
}

/**
 * @param {string} str
 */
function isBlank(str) {
    return (!str || /^\s*$/.test(str));
}

/**
 * @param {string} name
 */
function createFileName(name) {
    let r = '';
    for (let i = 0; i < name.length; i++) {
        let c = name[i];
        if (c == c.toUpperCase()) {
            if (i == 0) r += c.toLowerCase();
            else r += '_' + c.toLowerCase();
        } else {
            r += c;
        }
    }

    return r;
}

// function getCurrentPath() {
//     let path = vscode.window.activeTextEditor.document.fileName;
//     let dirs = path.split("\\");
//     path = '';
//     for (let i = 0; i < dirs.length; i++) {
//         let dir = dirs[i];
//         if (i < dirs.length - 1) {
//             path += dir + "\\";
//         }
//     }

//     return path;
// }

// /**
//  * @param {string} content
//  * @param {string} name
//  */
// async function writeFile(content, name, open = true, path = getCurrentPath()) {
//     let p = path + name + '.dart';
//     if (fs.existsSync(p)) {
//         let i = 0;
//         do {
//             p = path + name + '_' + ++i + '.dart'
//         } while (fs.existsSync(p));
//     }

//     fs.writeFileSync(p, content, 'utf8');
//     if (open) {
//         let openPath = vscode.Uri.parse("file:///" + p);
//         let doc = await vscode.workspace.openTextDocument(openPath);
//         await vscode.window.showTextDocument(doc);
//     }
//     return;
// }

    function getCurrentPath() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            console.error('No active editor found');
            return '';
        }
        const filePath = editor.document.fileName;
        const path = require('path');
        return path.dirname(filePath); // Returns the directory of the current file
    }

    /**
     * @param {string} content
     * @param {string} name
     */
    async function writeFile(content, name, open = true, dirPath = getCurrentPath()) {
        const path = require('path');
        let filePath = path.join(dirPath, `${name}.dart`);
        
        // Check for file existence and append suffix if needed
        let i = 0;
        while (fs.existsSync(filePath)) {
            i++;
            filePath = path.join(dirPath, `${name}_${i}.dart`);
        }

        try {
            // Ensure directory exists
            await fs.promises.mkdir(dirPath, { recursive: true });
            // Write file
            await fs.promises.writeFile(filePath, content, 'utf8');
            console.log(`Successfully wrote file: ${filePath}`);
            
            if (open) {
                const openPath = vscode.Uri.file(filePath);
                const doc = await vscode.workspace.openTextDocument(openPath);
                await vscode.window.showTextDocument(doc);
            }
        } catch (error) {
            console.error(`Failed to write file ${filePath}:`, error);
            vscode.window.showErrorMessage(`Failed to create file ${filePath}: ${error.message}`);
            throw error; // Rethrow to ensure caller knows about the failure
        }
    }

/**
 * @param {string} source
 */
function toVarName(source) {
    let s = source;
    let r = '';

    /**
     * @param {string} char
     */
    let replace = (char) => {
        if (s.includes(char)) {
            const splits = s.split(char);
            for (let i = 0; i < splits.length; i++) {
                let w = splits[i];
                i > 0 ? r += capitalize(w) : r += w;
            }
        }
    }

    replace('-');
    replace('~');
    replace(':');
    replace('#');
    replace('$');

    if (r.length == 0)
        r = s;

    const keywords = [
        'assert', 'break', 'case', 'catch', 'class', 'const', 'continue',
        'default', 'do', 'else', 'enum', 'extends', 'false', 'final',
        'finally', 'for', 'if', 'in', 'is', 'new', 'null', 'rethrow',
        'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
        'var', 'void', 'while', 'with'
    ];

    if (keywords.includes(r)) {
        r = r + '_';
    }

    if (r.length > 0 && r[0].match(new RegExp(/[0-9]/)))
        r = 'n' + r;

    return r;
}

function camelCase(str) {
    const snakeToCamel =
        str.replace(/([-_][a-z])/g, group =>
            group
                .toUpperCase()
                .replace('-', '')
                .replace('_', '')
        );

    return snakeToCamel;
}

/**
 * @param {string} src
 */
function varToKey(src) {
    const snakeCase = string => {
        return string.replace(/\W+/g, " ")
            .split(/ |\B(?=[A-Z])/)
            .map(word => word.toLowerCase())
            .join('_');
    };

    const format = readSetting("json.key_format")

    switch (format) {
        case 'snake_case': return snakeCase(src);
        case 'camelCase': return camelCase(src);
        default: return src;
    }
}

/**
 * @param {vscode.TextEditorEdit} editor
 * @param {number} start
 * @param {number} end
 * @param {string} value
 */
function editorReplace(editor, start = null, end = null, value) {
    editor.replace(new vscode.Range(
        new vscode.Position(start || 0, 0),
        new vscode.Position(end || getDocText().split('\n').length, 1)
    ),
        value
    );
}

/**
 * @param {vscode.TextEditorEdit} editor
 * @param {number} at
 * @param {string} value
 */

function editorInsert(editor, at, value) {
    editor.insert(new vscode.Position(at, 0), value);
}

/**
 * @param {vscode.TextEditorEdit} editor
 * @param {number} from
 * @param {number} to
 */
function editorDelete(editor, from = null, to = null) {
    editor.delete(
        new vscode.Range(
            new vscode.Position(from || 0, 0),
            new vscode.Position(to || getDocText().split('\n').length, 1)
        )
    );
}

/**
 * @param {number} from
 * @param {number} to
 */
function scrollTo(from = null, to = null) {
    getEditor().revealRange(
        new vscode.Range(
            new vscode.Position(from || 0, 0),
            new vscode.Position(to || 0, 0)
        ),
        0
    );
}

function clearSelection() {
    getEditor().selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
}

/**
 * @param {string} source
 */
function capitalize(source) {
    let s = source;
    if (s.length > 0) {
        if (s.length > 1) {
            return s.substr(0, 1).toUpperCase() + s.substring(1, s.length);
        } else {
            return s.substr(0, 1).toUpperCase();
        }
    }

    return s;
}

/**
 * @param {string} source
 * @param {string | any[]} start
 */
function removeStart(source, start) {
    if (Array.isArray(start)) {
        let result = source.trim();
        for (let s of start) {
            result = removeStart(result, s).trim();
        }
        return result;
    } else {
        return source.startsWith(start) ? source.substring(start.length, source.length) : source;
    }
}

/**
 * @param {string} source
 * @param {string | any[]} end
 */
function removeEnd(source, end) {
    if (Array.isArray(end)) {
        let result = source.trim();
        for (let e of end) {
            result = removeEnd(result, e).trim();
        }
        return result;
    } else {
        const pos = (source.length - end.length);
        return source.endsWith(end) ? source.substring(0, pos) : source;
    }
}

/**
 * @param {string} source
 */
function indent(source) {
    let r = '';
    for (let line of source.split('\n')) {
        r += '  ' + line + '\n';
    }
    return r.length > 0 ? r : source;
}

/**
* @param {string} source
* @param {string} match
*/
function count(source, match) {
    let count = 0;
    let length = match.length;
    for (let i = 0; i < source.length; i++) {
        let part = source.substr((i * length) - 1, length);
        if (part == match) {
            count++;
        }
    }

    return count;
}

/**
 * @param {string} a
 * @param {string} b
 */
function areStrictEqual(a, b) {
    let x = a.replace(/\s/g, "");
    let y = b.replace(/\s/g, "");
    return x === y;
}

/**
* @param {string} source
* @param {string[]} matches
*/
function removeAll(source, matches) {
    let r = '';
    for (let s of source) {
        if (!matches.includes(s)) {
            r += s;
        }
    }
    return r;
}

/**
* @param {string} source
* @param {string[]} matches
*/
function includesOne(source, matches, wordBased = true) {
    const words = wordBased ? source.split(' ') : [source];
    for (let word of words) {
        for (let match of matches) {
            if (wordBased) {
                if (word === match)
                    return true;
            } else {
                if (source.includes(match))
                    return true;
            }
        }
    }

    return false;
}

/**
* @param {string} source
* @param {string[]} matches
*/
function includesAll(source, matches) {
    for (let match of matches) {
        if (!source.includes(match))
            return false;
    }
    return true;
}

function getEditor() {
    return vscode.window.activeTextEditor;
}

function getDoc() {
    return getEditor().document;
}

function getDocText() {
    return getDoc().getText();
}

function getLangId() {
    return getDoc().languageId;
}

/**
 * @param {string} key
 */
function readSetting(key) {
    return vscode.workspace.getConfiguration().get('dart-data-class-generator.' + key);
}

/**
 * @param {string[]} keys
 */
function readSettings(keys) {
    for (let key of keys) {
        if (readSetting(key)) {
            return true;
        }
    }

    return false;
}

/**
 * @param {string} msg
 */
function showError(msg) {
    vscode.window.showErrorMessage(msg);
}

/**
 * @param {string} msg
 */
function showInfo(msg) {
    vscode.window.showInformationMessage(msg);
}

function deactivate() { }

module.exports = {
    activate,
    deactivate,
    generateDataClass,
    generateJsonDataClass,
    DartFile,
    DartClass,
    DataClassGenerator,
    JsonReader,
    ClassPart,
    ClassField,
    writeFile,
    getCurrentPath,
    toVarName,
    createFileName,
    editorInsert,
    editorReplace,
    editorDelete,
    capitalize,
    scrollTo,
    clearSelection,
    removeEnd,
    indent,
    count,
    areStrictEqual,
    removeAll,
    includesOne,
    includesAll,
    getEditor,
    getDoc,
    getDocText,
    getLangId,
    readSetting,
    showError,
    showInfo
}
