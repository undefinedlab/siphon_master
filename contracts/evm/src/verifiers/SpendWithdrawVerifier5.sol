// SPDX-License-Identifier: GPL-3.0
// siphon-zkv2 withdraw5 zkey sha256=45ec9499035888952188372cb4856919a5c7eb23ae34c0f8181c691e444cb990
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract SpendWithdrawVerifier5 {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 4580662839011174594515474839531762665476444638142026831746976337577717383665;
    uint256 constant deltax2 = 5506049185826224287408407594620187463341814131746179561739573510379785256947;
    uint256 constant deltay1 = 3569818737278656874059033972416244593998827004321679471914943667609724825520;
    uint256 constant deltay2 = 10229270450391977270170638878923533030954287441524780599456916083310877193959;


    uint256 constant IC0x = 10263322690735288000544784156422192583954687922893584836823074759207665962443;
    uint256 constant IC0y = 12390457323346984554317782251521948016332952464317889257408465492421583719883;

    uint256 constant IC1x = 13829410723970020160346248941760696244118651378165036825545644712169339333035;
    uint256 constant IC1y = 17246079269289346783636630283734406098419144112913189514681497327461534086448;

    uint256 constant IC2x = 11516675405085012123917223923987589528781293604717168324123069883367829851909;
    uint256 constant IC2y = 17513684852866657837389484929904079569724721750438772031448035866084439350993;

    uint256 constant IC3x = 1251549289644790973006288224048747975231545419197059732401026203691078030002;
    uint256 constant IC3y = 10136443646771940050064327873484917482071786058069158848204199450171602895706;

    uint256 constant IC4x = 10492452623082209199902388291509089261969368924167698666126284396380211806622;
    uint256 constant IC4y = 652993590808273245082658855657448326832426148799554319724560046994571512755;

    uint256 constant IC5x = 7905228310085476975780554585223182773521636298619419971084458824443678211833;
    uint256 constant IC5y = 11828959665634416665397573070967648600824432853601966912787480042008872023475;

    uint256 constant IC6x = 9263260881528852457088563644689810298033750585284146884923355074730368375630;
    uint256 constant IC6y = 7841054954382169209762065269497501802370255871303447261504449269470688571348;

    uint256 constant IC7x = 16849464437155537779877235367205027658640986632625368189678577772191889210094;
    uint256 constant IC7y = 5627965009477606605355512985542488004245745243275651187211223802933380513532;

    uint256 constant IC8x = 1912361579945452645207388664002197233290941241538173073848590426564130934611;
    uint256 constant IC8y = 11152660098483077161491788378943899335622854779669377959286777347661400898692;

    uint256 constant IC9x = 17040152439896905967588935496490778882038317226934742011910448489802996249060;
    uint256 constant IC9y = 16365739171382005119372866425700283227045424465409943081255336754926322943762;

    uint256 constant IC10x = 8785942820210079325304621865577247774404988095504834632524737167749462042577;
    uint256 constant IC10y = 16656924853975836468700517100872090446592459289481166255616566704208947179499;

    uint256 constant IC11x = 15658793960189422261588037773401813297289506218255096390998436241224710017625;
    uint256 constant IC11y = 1963623561603486346848326723895719123995104191568526278622135450787854269838;

    uint256 constant IC12x = 19771026905670817567995490059846173757094376054501479815866845041374410713520;
    uint256 constant IC12y = 15270751374011062228771804063168445907721878228342869420334647661136997937982;

    uint256 constant IC13x = 12869734811344427866781438203088680184848834936831729157641889443138437834901;
    uint256 constant IC13y = 18028308985618918216330088480089454441556453854613418879544115735218120819319;

    uint256 constant IC14x = 6876664378716390469547837684488502325602724273704392822880840999378492536007;
    uint256 constant IC14y = 20428431168970951615729954724005539443744317366444491441164213334429764110022;

    uint256 constant IC15x = 4234165731293333687349243446071461429327120429193953026967122763179046448712;
    uint256 constant IC15y = 1968944878618331834314832693467859125674056664395266494206594514370949719203;

    uint256 constant IC16x = 12255527588166777538520870899407093853560748288957855014197686399849021509018;
    uint256 constant IC16y = 144265463041334383039249860145299048175564765933203852264280026414844097249;

    uint256 constant IC17x = 21689190134863202818867856029411567789653172493692804334704178639989672933014;
    uint256 constant IC17y = 1106244721943838045871989608533036100559094136743064843435733832205953160096;

    uint256 constant IC18x = 18633226798577609641090289805430946143512674478483357790278830889309972190383;
    uint256 constant IC18y = 8446978481166057092786454855184452261998272580297124918385614357739700050998;

    uint256 constant IC19x = 15388227427945343976524431057464195414034593718832350080539820586524732921797;
    uint256 constant IC19y = 17535444215796426408450729122768469741011368036974323897564417520155429249088;

    uint256 constant IC20x = 13870539398249185217195909455997423749722402824111419151718764680209564851288;
    uint256 constant IC20y = 21292354772480163782929943792002286915126018081740509120740489745016643317219;

    uint256 constant IC21x = 8954566910476343268132619043390839721060178058116880492638945082585750431319;
    uint256 constant IC21y = 2310346825365766434518994571116858984261646486073660809310803495473461918472;

    uint256 constant IC22x = 16712114747472196619344087769082545381858193071949703922276673051938045575586;
    uint256 constant IC22y = 2173538341534506540826469070660692226370020674949475340652747953319969334552;

    uint256 constant IC23x = 8024321590463327359387737628996187201958451733396403525405923283057574629255;
    uint256 constant IC23y = 1044265936351026555722557266986050792524913836214155482343755068389949612016;

    uint256 constant IC24x = 3804246210230816128127288382780498936549153771035765951003908704767086253907;
    uint256 constant IC24y = 10496078478705976878478570254474505176265240276797576444583863272885209971411;

    uint256 constant IC25x = 16052643278548957927655268683540635702972030307494570938981294850122742816567;
    uint256 constant IC25y = 21878306672763443372143573610346086792445862012014491740325116514666032290203;


    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[25] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x

                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))

                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))

                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))

                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))

                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))

                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))

                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))

                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))

                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))

                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))

                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))

                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))

                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))

                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))

                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))

                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))

                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))

                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))

                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))

                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))

                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))

                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))

                g1_mulAccC(_pVk, IC23x, IC23y, calldataload(add(pubSignals, 704)))

                g1_mulAccC(_pVk, IC24x, IC24y, calldataload(add(pubSignals, 736)))

                g1_mulAccC(_pVk, IC25x, IC25y, calldataload(add(pubSignals, 768)))


                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F

            checkField(calldataload(add(_pubSignals, 0)))

            checkField(calldataload(add(_pubSignals, 32)))

            checkField(calldataload(add(_pubSignals, 64)))

            checkField(calldataload(add(_pubSignals, 96)))

            checkField(calldataload(add(_pubSignals, 128)))

            checkField(calldataload(add(_pubSignals, 160)))

            checkField(calldataload(add(_pubSignals, 192)))

            checkField(calldataload(add(_pubSignals, 224)))

            checkField(calldataload(add(_pubSignals, 256)))

            checkField(calldataload(add(_pubSignals, 288)))

            checkField(calldataload(add(_pubSignals, 320)))

            checkField(calldataload(add(_pubSignals, 352)))

            checkField(calldataload(add(_pubSignals, 384)))

            checkField(calldataload(add(_pubSignals, 416)))

            checkField(calldataload(add(_pubSignals, 448)))

            checkField(calldataload(add(_pubSignals, 480)))

            checkField(calldataload(add(_pubSignals, 512)))

            checkField(calldataload(add(_pubSignals, 544)))

            checkField(calldataload(add(_pubSignals, 576)))

            checkField(calldataload(add(_pubSignals, 608)))

            checkField(calldataload(add(_pubSignals, 640)))

            checkField(calldataload(add(_pubSignals, 672)))

            checkField(calldataload(add(_pubSignals, 704)))

            checkField(calldataload(add(_pubSignals, 736)))

            checkField(calldataload(add(_pubSignals, 768)))


            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
