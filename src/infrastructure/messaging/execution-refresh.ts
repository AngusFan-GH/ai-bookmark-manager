/** Preserve execution truth if only index refresh fails: never imply native writes were rolled back. */
export async function executeWithIndexRefresh<T extends object>(execute:()=>Promise<T>,refresh:()=>Promise<unknown>,dryRun=false):Promise<T&{syncWarning?:string}>{
 const result=await execute();
 if(dryRun)return {...result,syncWarning:undefined};
 try{await refresh();return {...result,syncWarning:undefined};}
 catch{return {...result,syncWarning:'原生书签操作已有结果，但本地列表刷新失败。请刷新原生书签并核对操作历史，不要重复执行。'};}
}
