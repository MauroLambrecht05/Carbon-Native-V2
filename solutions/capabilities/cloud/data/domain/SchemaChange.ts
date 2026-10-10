import { PlatformFault, parseComponent, type DataSchemaChange } from '@carbon/contracts/platform';
import { validateDefinition, sameConstraintRule, type NativeDefinition } from './NativeTable.ts';

export function planSchemaChange(input: NativeDefinition, inputChange: DataSchemaChange) {
  let definition = structuredClone(input); const change = parseComponent('DataSchemaChange', structuredClone(inputChange));
  const dependencies: string[] = []; let destructive = false;
  if (change.kind === 'rename') definition = { ...definition, name: change.name };
  else if (change.kind === 'constraint.set') {
    const existing = definition.constraints?.find(constraint => constraint.id === change.constraint.id);
    if (existing) { dependencies.push('constraint:' + existing.id); destructive = !sameConstraintRule(existing, change.constraint); }
    definition = { ...definition, constraints: [...(definition.constraints ?? []).filter(constraint => constraint.id !== change.constraint.id), change.constraint] };
  } else if (change.kind === 'constraint.delete') {
    const existing = definition.constraints?.find(constraint => constraint.id === change.constraintId);
    if (!existing) throw new PlatformFault('not_found', 'Constraint not found');
    destructive = existing.kind !== 'index'; dependencies.push('constraint:' + existing.id);
    definition = { ...definition, constraints: definition.constraints!.filter(constraint => constraint.id !== change.constraintId) };
  }
  else if (change.kind === 'primary-key') {
    if (definition.primaryKey && definition.primaryKey !== change.column) { dependencies.push('primary-key:' + definition.primaryKey); destructive = true; }
    if (change.column === null) {
      const { primaryKey: _removed, ...remaining } = definition; definition = remaining;
    } else {
      if (!definition.columns.some(column => column.name === change.column)) throw new PlatformFault('not_found', 'Key column not found');
      definition = { ...definition, primaryKey: change.column, columns: definition.columns.map(column => column.name === change.column ? { ...column, nullable: false } : column) };
    }
  }
  else if (change.kind === 'column.add') {
    if (definition.columns.some(column => column.name === change.column.name)) throw new PlatformFault('conflict', 'Column already exists');
    definition = { ...definition, columns: [...definition.columns, change.column] };
  } else {
    const name = change.kind === 'column.drop' ? change.name : change.original;
    const index = definition.columns.findIndex(column => column.name === name);
    if (index < 0) throw new PlatformFault('not_found', 'Column not found');
    if (definition.primaryKey === name) dependencies.push('primary-key');
    for (const rule of definition.policies.rules) if (rule.kind === 'owner' && rule.ownerColumn === name) dependencies.push('policy:' + rule.id);
    for (const constraint of definition.constraints ?? []) if (constraint.columns.includes(name)) dependencies.push('constraint:' + constraint.id);
    if (change.kind === 'column.drop') {
      if (dependencies.length) throw new PlatformFault('conflict', 'Remove column dependencies first');
      definition = { ...definition, columns: definition.columns.filter((_, position) => position !== index) }; destructive = true;
    } else {
      if (change.column.name !== name && definition.columns.some(column => column.name === change.column.name)) throw new PlatformFault('conflict', 'Column already exists');
      destructive = definition.columns[index]!.type !== change.column.type;
      definition = { ...definition, columns: definition.columns.map((column, position) => position === index ? change.column : column),
        ...(definition.primaryKey === name ? { primaryKey: change.column.name } : {}),
        policies: { ...definition.policies, rules: definition.policies.rules.map(rule => rule.kind === 'owner' && rule.ownerColumn === name ? { ...rule, ownerColumn: change.column.name } : rule) },
        ...(definition.constraints ? { constraints: definition.constraints.map(constraint => ({ ...constraint,
          columns: constraint.columns.map(column => column === name ? change.column.name : column),
          ...(constraint.kind === 'check' ? { check: { ...constraint.check, column: constraint.check.column === name ? change.column.name : constraint.check.column } } : {}) })) } : {}) };
    }
  }
  return { definition: validateDefinition(definition), destructive, dependencies };
}
