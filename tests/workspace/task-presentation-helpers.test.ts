import {describe,it,expect} from 'vitest';
import {excludePlanStep,readDismissedViews,persistDismissedViews,presentationKey} from '../../entrypoints/options/workspace-helpers';
import type {OperationStep} from '../../src/domain/operations/types';
const step=(id:string,extra:Partial<OperationStep>={}):OperationStep=>({id,planId:'p',order:0,action:'move',targetBrowserId:id,parentBrowserId:'bar',expectedBefore:{},desiredAfter:{},reason:'Reviewed',riskLevel:'medium',dependsOn:[],status:'pending',inverseOfId:null,errorMessage:null,evidence:[],...extra});
describe('task presentation safety',()=>{
 it('drops dependent steps and remaps retained created-parent references',()=>{
  const steps=[step('omit'),step('folder',{action:'create',targetBrowserId:null,desiredAfter:{title:'New'}}),step('move',{parentStepId:'folder',dependsOn:['folder']}),step('dependent',{dependsOn:['omit']})];
  const result=excludePlanStep(steps,'omit');expect(result).toHaveLength(2);expect(result[1].parentStepIndex).toBe(0);expect(result[1].parentBrowserId).toBeUndefined();expect(steps).toHaveLength(4);
 });
 it('preserves containing folders when a child deletion is excluded',()=>{
  const result=excludePlanStep([step('child',{action:'delete',expectedBefore:{parentId:'parent'}}),step('parent',{action:'delete',expectedBefore:{parentId:'grand'}}),step('grand',{action:'delete'}),step('unrelated')],'child');
  expect(result.map(s=>s.targetBrowserId)).toEqual(['unrelated']);
 });
 it('excludes a new folder and every dependent move without writing',()=>{expect(excludePlanStep([step('folder',{action:'create'}),step('move',{parentStepId:'folder'})],'folder')).toEqual([]);});
 it('tolerates malformed or blocked local dismissal storage',()=>{expect(readDismissedViews({getItem:()=>'{broken'},'x')).toEqual([]);expect(()=>persistDismissedViews({setItem:()=>{throw Error('blocked');}},'x',['a'])).not.toThrow();expect(presentationKey('same')).toBe(presentationKey('same'));});
});
