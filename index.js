document.addEventListener("DOMContentLoaded", () => {
	const atomize = new Atomize();
	const vm = new Vue({
		el: '#vue',
		data: {
			mine: {},
			expression: ""
		},
		methods: {
			onEnter() {
				/*Handles race condition between asynchronous commit of array creation.
				  A better way would be to initialize Vue.js in the first transaction's continuation.*/
				if(atomize.root.messages){
					let result;
					
					try{
						result = Function(`return ${this.expression}`)();
					}
					catch(e){
						alert("The expression is invalid.");
						console.log(e);
					}
					
					if(typeof result === "number"){
						const display = `${this.expression} = ${result}`; 
						atomize.atomically(() => {
							atomize.root.messages.unshift(display);
							
							if(atomize.root.messages.length > 10) {
								atomize.root.messages.pop();
							}
						},
						() => {
							this.expression = '';
						});
					}
				}
			}
		}
	});
	atomize.onAuthenticated = () => {
    	atomize.atomically(() => {
    		let commit;
    		
        	if(atomize.root.messages){	//model graph object "messages" was already created
            	console.log("onAuthenticated: Read");
            }
            else{	//this client is the first, so initialize the model
            	console.log("onAuthenticated: Write");
                atomize.root.messages = atomize.lift([]);
            }
            vm.$set(vm.mine, "messages", atomize.root.messages);
            atomize.root.messages.push("poop");
        	return atomize.root.messages.length;	//Vue.js injects "__proto__" and changes arrays immediately (not deferred by AtomizeJS like normal writes)
        },
        length => {
            console.log(length);
            subscribe(length);
            
            function subscribe(knownLength){	//in this case, "knownLength" is essentially this client's current version number
	            atomize.atomically(() => {	//pulls changes made to the array
	            	if(atomize.root.messages[knownLength]){	//this check records a read of the item one beyond our known end of the array
	            		return atomize.root.messages.length; //the newly committed length (derived from the actual array data size to indicate that push() was called by someone)
	            	}
	            	else{	//wait for someone else to append to the end of the array
		            	atomize.retry();
	            	}
	            },
	            subscribe);
            }
        });
    };
    atomize.connect();
});
