import { defineBackend, defineDatabase, defineTable, s } from "clank.run";
export const databaseSchema = defineDatabase({
    todos: defineTable({
        title: s.string({
            min: 1,
            max: 160
        }),
        done: s.boolean()
    }).index("by_done", [
        "done"
    ])
});
const documentVersion = s.number({
    integer: true,
    min: 1
});
export const backend = defineBackend({
    schema: databaseSchema
}).functions(({ query, mutation })=>({
        todos: {
            list: query({
                args: {},
                handler: ({ db })=>db.table("todos").query().orderBy("_creationTime", "asc").collect()
            }),
            add: mutation({
                args: {
                    title: s.string({
                        min: 1,
                        max: 160
                    })
                },
                handler: ({ db }, { title })=>db.table("todos").insert({
                        title,
                        done: false
                    })
            }),
            toggle: mutation({
                args: {
                    id: s.id("todos"),
                    version: documentVersion
                },
                handler: ({ db }, { id, version })=>{
                    const todo = db.table("todos").get(id);
                    return todo ? db.table("todos").patch(id, {
                        done: !todo.done
                    }, {
                        ifVersion: version
                    }) : null;
                }
            }),
            remove: mutation({
                args: {
                    id: s.id("todos"),
                    version: documentVersion
                },
                handler: ({ db }, { id, version })=>db.table("todos").delete(id, {
                        ifVersion: version
                    })
            }),
            clearCompleted: mutation({
                args: {},
                handler: ({ db })=>{
                    const completed = db.table("todos").query().where("done", true).collect();
                    for (const todo of completed){
                        db.table("todos").delete(todo._id, {
                            ifVersion: todo._version
                        });
                    }
                    return completed.length;
                }
            })
        }
    }));


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9mdWxsc3RhY2svYmFja2VuZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUNFLGFBQWEsRUFDYixjQUFjLEVBQ2QsV0FBVyxFQUNYLENBQUMsUUFFSSxZQUFZO0FBRW5CLE9BQU8sTUFBTSxpQkFBaUIsZUFBZTtJQUMzQyxPQUFPLFlBQVk7UUFDakIsT0FBTyxFQUFFLE1BQU0sQ0FBQztZQUFFLEtBQUs7WUFBRyxLQUFLO1FBQUk7UUFDbkMsTUFBTSxFQUFFLE9BQU87SUFDakIsR0FBRyxLQUFLLENBQUMsV0FBVztRQUFDO0tBQU87QUFDOUIsR0FBRztBQUdILE1BQU0sa0JBQWtCLEVBQUUsTUFBTSxDQUFDO0lBQUUsU0FBUztJQUFNLEtBQUs7QUFBRTtBQUV6RCxPQUFPLE1BQU0sVUFBVSxjQUFjO0lBQUUsUUFBUTtBQUFlLEdBQUcsU0FBUyxDQUFDLENBQUMsRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLEdBQUssQ0FBQztRQUNuRyxPQUFPO1lBQ0wsTUFBTSxNQUFNO2dCQUNWLE1BQU0sQ0FBQztnQkFDUCxTQUFTLENBQUMsRUFBRSxFQUFFLEVBQUUsR0FBSyxHQUFHLEtBQUssQ0FBQyxTQUFTLEtBQUssR0FBRyxPQUFPLENBQUMsaUJBQWlCLE9BQU8sT0FBTztZQUN4RjtZQUNBLEtBQUssU0FBUztnQkFDWixNQUFNO29CQUFFLE9BQU8sRUFBRSxNQUFNLENBQUM7d0JBQUUsS0FBSzt3QkFBRyxLQUFLO29CQUFJO2dCQUFHO2dCQUM5QyxTQUFTLENBQUMsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxHQUFLLEdBQUcsS0FBSyxDQUFDLFNBQVMsTUFBTSxDQUFDO3dCQUFFO3dCQUFPLE1BQU07b0JBQU07WUFDaEY7WUFDQSxRQUFRLFNBQVM7Z0JBQ2YsTUFBTTtvQkFBRSxJQUFJLEVBQUUsRUFBRSxDQUFDO29CQUFVLFNBQVM7Z0JBQWdCO2dCQUNwRCxTQUFTLENBQUMsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxPQUFPLEVBQUU7b0JBQy9CLE1BQU0sT0FBTyxHQUFHLEtBQUssQ0FBQyxTQUFTLEdBQUcsQ0FBQztvQkFDbkMsT0FBTyxPQUNILEdBQUcsS0FBSyxDQUFDLFNBQVMsS0FBSyxDQUFDLElBQUk7d0JBQUUsTUFBTSxDQUFDLEtBQUssSUFBSTtvQkFBQyxHQUFHO3dCQUFFLFdBQVc7b0JBQVEsS0FDdkU7Z0JBQ047WUFDRjtZQUNBLFFBQVEsU0FBUztnQkFDZixNQUFNO29CQUFFLElBQUksRUFBRSxFQUFFLENBQUM7b0JBQVUsU0FBUztnQkFBZ0I7Z0JBQ3BELFNBQVMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLE9BQU8sRUFBRSxHQUMvQixHQUFHLEtBQUssQ0FBQyxTQUFTLE1BQU0sQ0FBQyxJQUFJO3dCQUFFLFdBQVc7b0JBQVE7WUFDdEQ7WUFDQSxnQkFBZ0IsU0FBUztnQkFDdkIsTUFBTSxDQUFDO2dCQUNQLFNBQVMsQ0FBQyxFQUFFLEVBQUUsRUFBRTtvQkFDZCxNQUFNLFlBQVksR0FBRyxLQUFLLENBQUMsU0FBUyxLQUFLLEdBQUcsS0FBSyxDQUFDLFFBQVEsTUFBTSxPQUFPO29CQUN2RSxLQUFLLE1BQU0sUUFBUSxVQUFXO3dCQUM1QixHQUFHLEtBQUssQ0FBQyxTQUFTLE1BQU0sQ0FBQyxLQUFLLEdBQUcsRUFBRTs0QkFBRSxXQUFXLEtBQUssUUFBUTt3QkFBQztvQkFDaEU7b0JBQ0EsT0FBTyxVQUFVLE1BQU07Z0JBQ3pCO1lBQ0Y7UUFDRjtJQUNGLENBQUMsR0FBRyJ9