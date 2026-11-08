// Run long DOM suites without keeping a single page.evaluate call pending.
export async function run(page,name){
  await page.evaluate(name=>{
    globalThis.__bookTestState={done:false};
    Promise.resolve().then(()=>globalThis[name]()).then(result=>{globalThis.__bookTestState={done:true,result};}).catch(error=>{globalThis.__bookTestState={done:true,error:String(error.stack||error)};});
    return {started:name};
  },name);
  await page.waitForFunction(()=>globalThis.__bookTestState?.done,undefined,{timeout:60000});
  const state=await page.evaluate(()=>globalThis.__bookTestState);
  if(state.error)throw new Error(state.error);
  return state.result;
}
