import traverse from '@babel/traverse';
import * as t from '@babel/types';
import * as path from 'path';
import * as glob from 'glob';
import { workspace } from 'vscode';
import { parse as jsParse } from '@babel/parser';
import { TYPESCRIPT } from './parser';
import logger from '../logger';

const PARSE_PLUGINS = [
  'jsx',
  'asyncFunctions',
  'classConstructorCall',
  'doExpressions',
  'trailingFunctionCommas',
  'objectRestSpread',
  ['decorators', { decoratorsBeforeExport: true }],
  'classProperties',
  'exportExtensions',
  'exponentiationOperator',
  'asyncGenerators',
  'functionBind',
  'functionSent',
  'dynamicImport',
];
const PARSE_JS_PLUGINS = ['flow', ...PARSE_PLUGINS];
const PARSE_TS_PLUGINS = ['typescript', ...PARSE_PLUGINS];

const configuration = workspace.getConfiguration('vulnCost');
const typescriptRegex = new RegExp(
  configuration.typescriptExtensions.join('|')
);
const javascriptRegex = new RegExp(
  configuration.javascriptExtensions.join('|')
);

/**
 * @param {string} path
 *
 * @returns {boolean}
 */
function doesFileExist(path) {
  const foundFiles = [
    ...glob.sync(`${path}/index.*`),
    ...glob.sync(`${path}.*`),
  ];
  if (!foundFiles.length) {
    return false;
  }
  let fileExists = false;

  for (let idx = 0; idx < foundFiles.length; idx++) {
    const file = foundFiles[idx];
    if (typescriptRegex.test(file) || javascriptRegex.test(file)) {
      fileExists = true;
      break;
    }
  }

  return fileExists;
}

export function getPackages(fileName, source, language) {
  const packages = [];
  const visitor = {
    ImportDeclaration({ node }) {
      const configuration = workspace.getConfiguration('vulnCost');
      let pathIgnored = false;

      for (let i = 0; i < configuration.ignorePaths.length; i++) {
        const path = configuration.ignorePaths[i];
        pathIgnored = new RegExp(path).test(node.source.value);

        if (pathIgnored) {
          break;
        }
      }

      if (pathIgnored) {
        logger.log(`Import ${node.source.value} matched ignored path: ${path}`);
        return;
      }

      const target = path.dirname(fileName) + path.sep + node.source.value;

      if (!doesFileExist(target)) {
        logger.log(`Found import declaration: ${node.source.value}`);
        packages.push({
          fileName,
          loc: node.source.loc,
          name: node.source.value,
          line: node.loc.end.line,
          string: compileImportString(node),
        });
      }
    },
    CallExpression({ node }) {
      if (node.callee.name === 'require') {
        packages.push({
          fileName,
          name: getPackageName(node),
          line: node.loc.end.line,
          loc: node.arguments[0].loc,
          string: compileRequireString(node),
        });
      } else if (node.callee.type === 'Import') {
        packages.push({
          fileName,
          loc: node.arguments[0].loc,
          name: getPackageName(node),
          line: node.loc.end.line,
          string: compileImportExpressionString(node),
        });
      }
    },
  };

  const ast = parse(source, language);
  traverse(ast, visitor);
  return packages;
}

function parse(source, language) {
  const plugins = language === TYPESCRIPT ? PARSE_TS_PLUGINS : PARSE_JS_PLUGINS;
  return jsParse(source, {
    sourceType: 'module',
    plugins,
  });
}

function compileImportString(node) {
  let importSpecifiers, importString;
  if (node.specifiers && node.specifiers.length > 0) {
    importString = []
      .concat(node.specifiers)
      .sort((s1, s2) => {
        // Import specifiers are in statement order, which for mixed imports must be either "defaultImport, * as namespaceImport"
        // or "defaultImport, { namedImport [as alias]... } according to current ECMA-262.
        // Given that two equivalent import statements can only differ in the order of the items in a NamedImports block,
        // we only need to sort these items in relation to each other to normalise the statements for caching purposes.
        // Where the node is anything other than ImportSpecifier (Babel terminology for NamedImports), preserve the original statement order.
        if (t.isImportSpecifier(s1) && t.isImportSpecifier(s2)) {
          return s1.imported.name < s2.imported.name ? -1 : 1;
        }
        return 0;
      })
      .map((specifier, i) => {
        if (t.isImportNamespaceSpecifier(specifier)) {
          return `* as ${specifier.local.name}`;
        } else if (t.isImportDefaultSpecifier(specifier)) {
          return specifier.local.name;
        } else if (t.isImportSpecifier(specifier)) {
          if (!importSpecifiers) {
            importSpecifiers = '{';
          }
          importSpecifiers += specifier.imported.name;
          if (
            node.specifiers[i + 1] &&
            t.isImportSpecifier(node.specifiers[i + 1])
          ) {
            importSpecifiers += ', ';
            return undefined;
          } else {
            const result = importSpecifiers + '}';
            importSpecifiers = undefined;
            return result;
          }
        } else {
          return undefined;
        }
      })
      .filter(x => x)
      .join(', ');
  } else {
    importString = '* as tmp';
  }
  return `import ${importString} from '${
    node.source.value
  }';\nconsole.log(${importString.replace('* as ', '')});`;
}

function compileRequireString(node) {
  return `require('${getPackageName(node)}')`;
}

function compileImportExpressionString(node) {
  return `import('${getPackageName(node)}').then(res => console.log(res));`;
}

function getPackageName(node) {
  return t.isTemplateLiteral(node.arguments[0])
    ? node.arguments[0].quasis[0].value.raw
    : node.arguments[0].value;
}
